#pragma once
#include "backend-journal-codec.h"
#include "backend-process-witness.h"
#include <utility>

namespace backend_runtime {
// Persistence and profile deletion are native-owned dependencies. Tests can
// substitute them without touching a real control root or AppContainer profile.
struct JournalApi {
    virtual ~JournalApi()=default;
    virtual void verify()=0;
    virtual void write(const std::string& bytes)=0;
    virtual void flush()=0;
    virtual std::string read()=0;
    virtual void deleteProfile(const std::wstring& profile)=0;
};
class WindowsJournalApi final:public JournalApi {
    Ownership& ownership;std::unique_ptr<Pinned> file;
public:
    WindowsJournalApi(Ownership& owned,const std::string& initial):ownership(owned) {
        auto path=owned.controlRoot+L"\\recovery.journal";if(owned.created)privateFileCreate(path,owned.owner,initial);
        file=std::make_unique<Pinned>(path,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,0);privatePolicy(*file,owned.owner);
        if(!SetHandleInformation(file->handle.value,HANDLE_FLAG_INHERIT,0))throw WinError("journal-noninherited");
        exactEntries(owned.controlRoot,{L"owner.lock",L"owner.marker",L"recovery.journal"});
    }
    void verify() override{ownership.verify();privatePolicy(*file,ownership.owner);}
    void write(const std::string& bytes) override{
        LARGE_INTEGER zero={};if(!SetFilePointerEx(file->handle.value,zero,nullptr,FILE_BEGIN))throw WinError("journal-rewind");
        writeAll(file->handle.value,reinterpret_cast<const BYTE*>(bytes.data()),bytes.size());if(!SetEndOfFile(file->handle.value))throw WinError("journal-end");
    }
    void flush() override{if(!FlushFileBuffers(file->handle.value))throw WinError("journal-flush");}
    std::string read() override{return readSmall(file->handle.value,4096);}
    void deleteProfile(const std::wstring& profile) override{HRESULT result=DeleteAppContainerProfile(profile.c_str());if(FAILED(result))throw WinError("profile-delete",static_cast<DWORD>(result));}
};
class Journal {
    Ownership* ownership=nullptr;JournalContext context;std::unique_ptr<WindowsJournalApi> windows;JournalApi* api=nullptr;JournalRecord record;bool blocked=false;
    void requireUsable() const{if(blocked)throw WinError("journal-blocked",ERROR_INVALID_STATE);}
    void commit(const JournalRecord& next) {
        requireUsable();
        try {auto bytes=serializeJournal(next,context);api->verify();api->write(bytes);api->flush();
            if(api->read()!=bytes)throw WinError("journal-write-readback",ERROR_INVALID_DATA);record=next;
        }catch(...){blocked=true;throw;}
    }
public:
    explicit Journal(Ownership& owned):ownership(&owned),context{runtimePackageDigest,narrow(owned.owner.text),idText(owned.state->id),idText(owned.data->id)} {
        windows=std::make_unique<WindowsJournalApi>(owned,serializeJournal(record,context));api=windows.get();record=parseJournal(api->read(),context);
    }
    Journal(const JournalContext& expected,JournalApi& native):context(expected),api(&native){api->verify();record=parseJournal(api->read(),context);}
    const JournalRecord& current() const{requireUsable();return record;}
    void requireRecorded() const{requireUsable();if(record.phase!=Phase::Prepared||record.processState!=ProcessState::Recorded)throw WinError("journal-process-unrecorded",ERROR_INVALID_STATE);}
    void creatingProcess(){requireUsable();if(record.phase!=Phase::Prepared||record.profileState!="OWNED"||record.processState!=ProcessState::None)throw WinError("journal-process-create-order",ERROR_INVALID_STATE);
        auto next=record;next.processState=ProcessState::Creating;commit(next);}
    void recordProcess(DWORD pid,uint64_t creation){requireUsable();if(record.phase!=Phase::Prepared||record.processState!=ProcessState::Creating)throw WinError("journal-process-record-order",ERROR_INVALID_STATE);
        auto next=record;next.processState=ProcessState::Recorded;next.processPid=pid;next.processCreationTime=creation;commit(next);}
    void begin(const std::wstring& run) {
        requireUsable();if(!ownership||record.phase!=Phase::Clean)throw WinError("journal-needs-recover",ERROR_INVALID_STATE);
        JournalRecord next;next.phase=Phase::Preparing;next.run=run;next.job=jobName(ownership->owner,run);next.profile=profileName(ownership->owner,run);
        Pinned session(sessionPath(ownership->stateRoot,run),true);requireOwner(session.handle.value,ownership->owner);next.sessionIdentity=idText(session.id);commit(next);
    }
    std::unique_ptr<ProfileSid> createProfile() {
        requireUsable();if(record.phase!=Phase::Preparing||record.profileState!="NONE")throw WinError("profile-create-phase",ERROR_INVALID_STATE);
        auto next=record;next.phase=Phase::ProfileCreating;next.profileState="CREATING";commit(next);
        auto sid=std::make_unique<ProfileSid>();HRESULT result=CreateAppContainerProfile(next.profile.c_str(),L"Tahtiapuri backend",L"Owned restricted backend worker",nullptr,0,&sid->value);
        // Failure or a crash before durable OWNED is intentionally ambiguous and blocks recovery.
        if(FAILED(result))throw WinError("profile-create",static_cast<DWORD>(result));verifyProfileSid(next.profile,sid->value);
        next.phase=Phase::ProfileOwned;next.profileState="OWNED";next.sid=sidText(sid->value);commit(next);return sid;
    }
    void advance(Phase phase) {
        requireUsable();
        bool valid=(phase==Phase::Prepared&&record.phase==Phase::ProfileOwned)||(phase==Phase::Running&&record.phase==Phase::Prepared)||
            (phase==Phase::Closing&&record.phase==Phase::Running)||(phase==Phase::Terminating&&record.phase!=Phase::Clean&&record.profileState!="CREATING")||
            (phase==Phase::Restoring&&record.phase==Phase::Terminating);
        if(!valid)throw WinError("journal-transition",ERROR_INVALID_STATE);auto next=record;next.phase=phase;commit(next);
    }
    void prepareResources(Resources& resources) {
        if(blocked||record.phase!=Phase::ProfileOwned||record.profileState!="OWNED"||resources.run!=record.run||!resources.session||idText(resources.session->id)!=record.sessionIdentity)throw WinError("journal-grant-order",ERROR_INVALID_STATE);
        LocalMemory sid;if(!ConvertStringSidToSidW(record.sid.c_str(),&sid.value))throw WinError("journal-grant-sid");verifyProfileSid(record.profile,sid.value);
        resources.prepare(sid.value);advance(Phase::Prepared);
    }
    void deleteProfile() {
        if(blocked||record.phase!=Phase::Restoring)throw WinError("profile-delete-phase",ERROR_INVALID_STATE);
        if(record.profileState=="CREATING")throw WinError("profile-ownership-ambiguous",ERROR_INVALID_STATE);
        auto next=record;
        if(next.profileState=="OWNED"){
            LocalMemory sid;if(!ConvertStringSidToSidW(next.sid.c_str(),&sid.value))throw WinError("profile-delete-sid");verifyProfileSid(next.profile,sid.value);
            api->deleteProfile(next.profile);
            next.profileState="DELETED";
        }
        if(next.profileState=="DELETED")next.phase=Phase::ProfileDeleted;commit(next);
    }
    void clean() {
        requireUsable();
        if((record.phase!=Phase::ProfileDeleted&&record.phase!=Phase::Restoring)||(record.profileState!="NONE"&&record.profileState!="DELETED"))throw WinError("journal-clean-order",ERROR_INVALID_STATE);
        commit(JournalRecord{});
    }
};

inline SECURITY_ATTRIBUTES jobAttributes(const Owner& owner,LocalMemory& descriptor) {
    auto text=L"O:"+owner.text+L"D:P(A;;0x001f003f;;;"+owner.text+L")(A;;0x001f003f;;;SY)";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value),nullptr))throw WinError("job-descriptor");
    return {sizeof(SECURITY_ATTRIBUTES),descriptor.value,FALSE};
}
inline void verifyJobSecurity(HANDLE job,const Owner& owner) {
    LocalMemory descriptor;PSID actualOwner=nullptr;PACL acl=nullptr;DWORD error=GetSecurityInfo(job,SE_KERNEL_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
        &actualOwner,nullptr,&acl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;
    if(error||!actualOwner||!EqualSid(actualOwner,owner.sid())||!GetSecurityDescriptorControl(descriptor.value,&control,&revision)||!(control&SE_DACL_PROTECTED)||!acl||acl->AceCount!=2)throw WinError("job-security",error?error:ERROR_INVALID_ACL);
    bool user=false,system=false;for(DWORD i=0;i<2;++i){void* raw=nullptr;if(!GetAce(acl,i,&raw))throw WinError("job-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if(ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE||ace->Header.AceFlags||ace->Mask!=JOB_OBJECT_ALL_ACCESS)throw WinError("job-ace-policy",ERROR_INVALID_ACL);
        if(EqualSid(&ace->SidStart,owner.sid())&&!user)user=true;else if(EqualSid(&ace->SidStart,owner.system.value)&&!system)system=true;else throw WinError("job-ace-sid",ERROR_INVALID_ACL);}
    if(!user||!system)throw WinError("job-ace-count",ERROR_INVALID_ACL);
}
inline JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits() {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit=1;limits.BasicLimitInformation.Affinity=1;limits.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS;limits.ProcessMemoryLimit=512ULL*1024*1024;return limits;
}
inline void verifyJobLimits(HANDLE job) {
    auto expected=jobLimits();JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual={};
    if(!QueryInformationJobObject(job,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr)||
        actual.BasicLimitInformation.LimitFlags!=expected.BasicLimitInformation.LimitFlags||actual.BasicLimitInformation.ActiveProcessLimit!=1||
        actual.BasicLimitInformation.Affinity!=1||actual.BasicLimitInformation.PriorityClass!=BELOW_NORMAL_PRIORITY_CLASS||actual.ProcessMemoryLimit!=expected.ProcessMemoryLimit||
        actual.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart||actual.BasicLimitInformation.PerJobUserTimeLimit.QuadPart||actual.BasicLimitInformation.MinimumWorkingSetSize||
        actual.BasicLimitInformation.MaximumWorkingSetSize||actual.JobMemoryLimit)throw WinError("job-limit-readback",ERROR_INVALID_DATA);
    DWORD flags=0;if(!GetHandleInformation(job,&flags)||(flags&HANDLE_FLAG_INHERIT))throw WinError("job-noninherited",ERROR_INVALID_DATA);
}
class NamedJob {
    const Owner& owner;
public:
    std::wstring name;Handle handle;bool absent=false;
    NamedJob(const Owner& user,const std::wstring& run,bool recovering=false):owner(user),name(jobName(user,run)) {
        if(recovering){handle.value=OpenJobObjectW(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE|READ_CONTROL,FALSE,name.c_str());
            if(!handle.value){DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND){absent=true;return;}throw WinError("recover-job-open",error);}}
        else {LocalMemory sd;auto sa=jobAttributes(owner,sd);SetLastError(ERROR_SUCCESS);handle.value=CreateJobObjectW(&sa,name.c_str());DWORD error=GetLastError();
            if(!handle.value)throw WinError("job-create",error);if(error==ERROR_ALREADY_EXISTS)throw WinError("job-name-collision",error);
            auto limits=jobLimits();if(!SetInformationJobObject(handle.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw WinError("job-set-limits");}
        verifyJobSecurity(handle.value,owner);verifyJobLimits(handle.value);
    }
    DWORD active() const {
        if(absent)return 0;JOBOBJECT_BASIC_ACCOUNTING_INFORMATION stats={};if(!QueryInformationJobObject(handle.value,JobObjectBasicAccountingInformation,&stats,sizeof(stats),nullptr))throw WinError("job-active-query");return stats.ActiveProcesses;
    }
    void terminateAndWait(TerminationBudget& budget) {
        if(absent)throw WinError("job-termination-handle-missing",ERROR_INVALID_STATE);
        budget.check();verifyJobSecurity(handle.value,owner);budget.check();verifyJobLimits(handle.value);budget.check();
        // An open recovery handle prevents last-handle death; explicit terminate is required.
        if(!TerminateJobObject(handle.value,42))throw WinError("job-terminate");budget.check();
        for(;;){const auto count=active();budget.check();if(count==0)return;budget.pause();}
    }
};
enum class RecoveryStage { JobTermination,Restore };
using RecoveryNotify=std::function<void(RecoveryStage,uint64_t)>;
enum class CleanupStep { JobEmpty,Restored,ProfileDeleted,SessionRemoved,Clean };
using CleanupNotify=std::function<void(CleanupStep)>;
struct RecoveryApi {
    virtual ~RecoveryApi()=default;
    virtual ProcessWitnessApi& witness()=0;
    virtual void verify()=0;
    virtual void baseline()=0;
    // true is an opened, authenticated exact Job; false is FILE_NOT_FOUND only.
    virtual bool openJob(const JournalRecord& record)=0;
    virtual void terminateJob(TerminationBudget& budget)=0;
    virtual void restore()=0;
    virtual void removeSession(const JournalRecord& record)=0;
};
class WindowsRecoveryApi final:public RecoveryApi {
    Ownership& ownership;Resources* resources;NamedJob* held;std::unique_ptr<NamedJob> recovered;
public:
    WindowsRecoveryApi(Ownership& owned,Resources* data=nullptr,NamedJob* current=nullptr):ownership(owned),resources(data),held(current){}
    ProcessWitnessApi& witness() override{return windowsProcessWitnessApi();}
    void verify() override{ownership.verify();}
    void baseline() override{ResourceTree clean;clean.walk(ownership.dataRoot,ownership.owner);clean.baseline(ownership.owner,false);}
    bool openJob(const JournalRecord& record) override{recovered=std::make_unique<NamedJob>(ownership.owner,record.run,true);held=recovered.get();return !held->absent;}
    void terminateJob(TerminationBudget& budget) override{if(!held)throw WinError("cleanup-job-creation-unproven",ERROR_INVALID_STATE);held->terminateAndWait(budget);}
    void restore() override{if(resources)resources->closePins();Resources::restorePersistent(ownership);}
    void removeSession(const JournalRecord& record) override{Resources::removeSession(ownership,record.run,record.sessionIdentity);}
};
inline void cleanupAfterWitness(Journal& journal,const JournalRecord& before,RecoveryApi& api,const RecoveryNotify& notify={},const CleanupNotify& progress={}) {
    // A proof is local to this call. There is deliberately no journal proof bit.
    // A poisoned journal fails here before restore, profile/session deletion or CLEAN.
    journal.current();if(notify)notify(RecoveryStage::Restore,api.witness().tick()+15000);
    journal.advance(Phase::Terminating);journal.advance(Phase::Restoring);api.restore();if(progress)progress(CleanupStep::Restored);
    journal.deleteProfile();if(progress)progress(CleanupStep::ProfileDeleted);
    api.removeSession(before);if(progress)progress(CleanupStep::SessionRemoved);
    journal.clean();if(progress)progress(CleanupStep::Clean);
}
inline void recoverOwned(Journal& journal,RecoveryApi& api,const RecoveryNotify& notify={}) {
    api.verify();const auto before=journal.current();
    if(before.phase==Phase::Clean){if(notify)notify(RecoveryStage::Restore,api.witness().tick()+15000);api.baseline();return;}
    if(before.profileState=="CREATING")throw WinError("recover-profile-ambiguous",ERROR_INVALID_STATE);
    TerminationBudget budget(api.witness());if(notify)notify(RecoveryStage::JobTermination,budget.deadline());budget.check();
    const bool found=api.openJob(before);budget.check();
    if(found)api.terminateJob(budget);
    else if(before.processState==ProcessState::Creating)throw WinError("recover-process-ambiguous",ERROR_INVALID_STATE);
    else if(before.processState==ProcessState::Recorded)proveRecordedProcessExit(api.witness(),budget,before.processPid,before.processCreationTime);
    budget.check();cleanupAfterWitness(journal,before,api,notify);
}
inline void cleanupCurrent(Journal& journal,RecoveryApi& api,const RecoveryNotify& notify={},const CleanupNotify& progress={}) {
    TerminationBudget budget(api.witness());if(notify)notify(RecoveryStage::JobTermination,budget.deadline());budget.check();
    // Always attempt bounded termination of the live broker's verified Job,
    // even when a preceding commit poisoned Journal. No journal advance precedes it.
    api.terminateJob(budget);budget.check();if(progress)progress(CleanupStep::JobEmpty);
    const auto before=journal.current();cleanupAfterWitness(journal,before,api,notify,progress);
}
struct Recovery {
    Ownership& ownership;Journal& journal;
    Recovery(Ownership& owned,Journal& log):ownership(owned),journal(log){}
    void run(const RecoveryNotify& notify={}){WindowsRecoveryApi api(ownership);recoverOwned(journal,api,notify);}
};
inline void createRecordedProcess(Journal& journal,const std::function<void()>& create,const std::function<std::pair<DWORD,uint64_t>()>& identity) {
    journal.creatingProcess();create();const auto process=identity();journal.recordProcess(process.first,process.second);
}
inline void resumeRecordedProcess(Journal& journal,const std::function<void()>& resume){journal.requireRecorded();resume();}
}
