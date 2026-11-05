#pragma once
#include "backend-resources.h"
#include <cstring>

namespace backend_runtime {
enum class Phase { Clean,Preparing,ProfileCreating,ProfileOwned,Prepared,Running,Closing,Terminating,Restoring,ProfileDeleted };
inline const char* phaseName(Phase phase) {
    switch(phase){case Phase::Clean:return "CLEAN";case Phase::Preparing:return "PREPARING";case Phase::ProfileCreating:return "PROFILE_CREATING";
    case Phase::ProfileOwned:return "PROFILE_OWNED";case Phase::Prepared:return "PREPARED";case Phase::Running:return "RUNNING";case Phase::Closing:return "CLOSING";
    case Phase::Terminating:return "TERMINATING";case Phase::Restoring:return "RESTORING";case Phase::ProfileDeleted:return "PROFILE_DELETED";}throw WinError("journal-phase",ERROR_INVALID_DATA);
}
inline Phase parsePhase(const std::string& text) {
    for(auto p:{Phase::Clean,Phase::Preparing,Phase::ProfileCreating,Phase::ProfileOwned,Phase::Prepared,Phase::Running,Phase::Closing,Phase::Terminating,Phase::Restoring,Phase::ProfileDeleted})
        if(text==phaseName(p))return p;throw WinError("journal-unknown-phase",ERROR_INVALID_DATA);
}
struct JournalRecord {
    Phase phase=Phase::Clean;std::wstring run,job,profile,sid;std::string sessionIdentity,profileState="NONE";
};
inline std::vector<std::string> journalLines(const std::string& value) {
    if(value.empty()||value.size()>4096||value.back()!='\n')throw WinError("journal-shape",ERROR_INVALID_DATA);
    std::vector<std::string> lines;size_t start=0;for(size_t at=0;at<value.size();++at){unsigned char c=value[at];if(c=='\n'){lines.push_back(value.substr(start,at-start));start=at+1;}else if(c<32||c>126)throw WinError("journal-character",ERROR_INVALID_DATA);}
    return lines;
}
struct ProfileSid {
    PSID value=nullptr;~ProfileSid(){if(value)FreeSid(value);}ProfileSid()=default;ProfileSid(const ProfileSid&)=delete;ProfileSid& operator=(const ProfileSid&)=delete;
};
inline void verifyProfileSid(const std::wstring& name,PSID sid) {
    if(name.size()>64||!IsValidSid(sid))throw WinError("profile-sid",ERROR_INVALID_SID);
    ProfileSid derived;HRESULT result=DeriveAppContainerSidFromAppContainerName(name.c_str(),&derived.value);
    if(FAILED(result)||!derived.value||!EqualSid(sid,derived.value))throw WinError("profile-derived-sid",FAILED(result)?static_cast<DWORD>(result):ERROR_INVALID_SID);
    SID_IDENTIFIER_AUTHORITY authority=SECURITY_APP_PACKAGE_AUTHORITY;
    if(std::memcmp(GetSidIdentifierAuthority(sid),&authority,sizeof(authority))!=0||*GetSidSubAuthorityCount(sid)!=8||*GetSidSubAuthority(sid,0)!=SECURITY_APP_PACKAGE_BASE_RID)
        throw WinError("profile-sid-shape",ERROR_INVALID_SID);
}
class Journal {
    Ownership& ownership;std::unique_ptr<Pinned> file;JournalRecord record;bool blocked=false;
    std::string serialize(const JournalRecord& r) const {
        auto optional=[](const std::wstring& text){return text.empty()?std::string("-"):narrow(text);};
        std::string body="TAHTIAPURI_BACKEND_JOURNAL_V1\n"+std::string(runtimePackageDigest)+"\n"+narrow(ownership.owner.text)+"\n"+
            idText(ownership.state->id)+"\n"+idText(ownership.data->id)+"\nOWNER_SYSTEM_PROTECTED_MEDIUM_V1\nCREATION_JOB_LIST_GLOBAL_V1\n"+
            phaseName(r.phase)+"\n"+optional(r.run)+"\n"+optional(r.job)+"\n"+optional(r.profile)+"\n"+(r.sessionIdentity.empty()?"-":r.sessionIdentity)+"\n"+r.profileState+"\n"+optional(r.sid)+"\n";
        return body+hashBytes(reinterpret_cast<const BYTE*>(body.data()),body.size())+"\n";
    }
    void validate(const JournalRecord& r) const {
        if(r.phase==Phase::Clean){if(!r.run.empty()||!r.job.empty()||!r.profile.empty()||!r.sid.empty()||!r.sessionIdentity.empty()||r.profileState!="NONE")throw WinError("journal-clean-fields",ERROR_INVALID_DATA);return;}
        if(!lowerHex(r.run,32)||!lowerHex(widen(r.sessionIdentity),24)||r.job!=jobName(ownership.owner,r.run)||r.profile!=profileName(ownership.owner,r.run)||r.profile.size()>64)throw WinError("journal-owned-names",ERROR_INVALID_DATA);
        if(r.profileState!="NONE"&&r.profileState!="CREATING"&&r.profileState!="OWNED"&&r.profileState!="DELETED")throw WinError("journal-profile-state",ERROR_INVALID_DATA);
        if(r.profileState=="OWNED"||r.profileState=="DELETED"){
            LocalMemory sid;if(!ConvertStringSidToSidW(r.sid.c_str(),&sid.value))throw WinError("journal-profile-sid");verifyProfileSid(r.profile,sid.value);
        }else if(!r.sid.empty())throw WinError("journal-unowned-sid",ERROR_INVALID_DATA);
        if((r.phase==Phase::Preparing&&r.profileState!="NONE")||(r.phase==Phase::ProfileCreating&&r.profileState!="CREATING")||
            (r.phase==Phase::ProfileOwned&&r.profileState!="OWNED")||(r.phase==Phase::ProfileDeleted&&r.profileState!="DELETED")||
            ((r.phase==Phase::Prepared||r.phase==Phase::Running||r.phase==Phase::Closing)&&r.profileState!="OWNED"))throw WinError("journal-phase-profile",ERROR_INVALID_DATA);
    }
    void commit(const JournalRecord& next) {
        if(blocked)throw WinError("journal-blocked",ERROR_INVALID_STATE);
        try {validate(next);ownership.verify();privatePolicy(*file,ownership.owner);auto bytes=serialize(next);writeFile(file->handle.value,bytes);
            if(readSmall(file->handle.value,4096)!=bytes)throw WinError("journal-write-readback",ERROR_INVALID_DATA);record=next;
        }catch(...){blocked=true;throw;}
    }
public:
    explicit Journal(Ownership& owned):ownership(owned) {
        auto path=owned.controlRoot+L"\\recovery.journal";if(owned.created)privateFileCreate(path,owned.owner,serialize(record));
        file=std::make_unique<Pinned>(path,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,0);privatePolicy(*file,owned.owner);
        if(!SetHandleInformation(file->handle.value,HANDLE_FLAG_INHERIT,0))throw WinError("journal-noninherited");
        auto bytes=readSmall(file->handle.value,4096);auto lines=journalLines(bytes);if(lines.size()!=15)throw WinError("journal-field-count",ERROR_INVALID_DATA);
        auto optional=[](const std::string& text){return text=="-"?std::wstring():widen(text);};
        record.phase=parsePhase(lines[7]);record.run=optional(lines[8]);record.job=optional(lines[9]);record.profile=optional(lines[10]);record.sessionIdentity=lines[11]=="-"?"":lines[11];record.profileState=lines[12];record.sid=optional(lines[13]);validate(record);
        if(serialize(record)!=bytes)throw WinError("journal-authentication",ERROR_INVALID_DATA);
        exactEntries(owned.controlRoot,{L"owner.lock",L"owner.marker",L"recovery.journal"});
    }
    const JournalRecord& current() const{if(blocked)throw WinError("journal-blocked",ERROR_INVALID_STATE);return record;}
    void begin(const std::wstring& run) {
        if(record.phase!=Phase::Clean)throw WinError("journal-needs-recover",ERROR_INVALID_STATE);
        JournalRecord next;next.phase=Phase::Preparing;next.run=run;next.job=jobName(ownership.owner,run);next.profile=profileName(ownership.owner,run);
        Pinned session(sessionPath(ownership.stateRoot,run),true);requireOwner(session.handle.value,ownership.owner);next.sessionIdentity=idText(session.id);commit(next);
    }
    std::unique_ptr<ProfileSid> createProfile() {
        if(record.phase!=Phase::Preparing||record.profileState!="NONE")throw WinError("profile-create-phase",ERROR_INVALID_STATE);
        auto next=record;next.phase=Phase::ProfileCreating;next.profileState="CREATING";commit(next);
        auto sid=std::make_unique<ProfileSid>();HRESULT result=CreateAppContainerProfile(next.profile.c_str(),L"Tahtiapuri backend",L"Owned restricted backend worker",nullptr,0,&sid->value);
        // Failure or a crash before durable OWNED is intentionally ambiguous and blocks recovery.
        if(FAILED(result))throw WinError("profile-create",static_cast<DWORD>(result));verifyProfileSid(next.profile,sid->value);
        next.phase=Phase::ProfileOwned;next.profileState="OWNED";next.sid=sidText(sid->value);commit(next);return sid;
    }
    void advance(Phase phase) {
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
            HRESULT result=DeleteAppContainerProfile(next.profile.c_str());if(FAILED(result))throw WinError("profile-delete",static_cast<DWORD>(result));
            next.profileState="DELETED";
        }
        if(next.profileState=="DELETED")next.phase=Phase::ProfileDeleted;commit(next);
    }
    void clean() {
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
    void terminateAndWait(DWORD timeout=5000) {
        if(absent)return;verifyJobSecurity(handle.value,owner);verifyJobLimits(handle.value);
        // An open recovery handle prevents last-handle death; explicit terminate is required.
        if(!TerminateJobObject(handle.value,42))throw WinError("job-terminate");auto began=now();
        for(;;){if(active()==0)return;if(now()-began>=timeout)throw WinError("job-empty-timeout",ERROR_TIMEOUT);Sleep(10);}
    }
};
enum class RecoveryStage { JobTermination,Restore };
struct Recovery {
    Ownership& ownership;Journal& journal;
    Recovery(Ownership& owned,Journal& log):ownership(owned),journal(log){}
    void run(const std::function<void(RecoveryStage)>& notify={}) {
        ownership.verify();const auto before=journal.current();
        // This trusted callback only publishes the broker's supervisor phase. It
        // must not reenter or mutate Journal; no journal reference is passed to it.
        if(before.phase==Phase::Clean){if(notify)notify(RecoveryStage::Restore);ResourceTree clean;clean.walk(ownership.dataRoot,ownership.owner);clean.baseline(ownership.owner,false);return;}
        if(before.profileState=="CREATING")throw WinError("recover-profile-ambiguous",ERROR_INVALID_STATE);
        // Journal validation authenticates the exact Global name, data identities and
        // creation-time Job-list contract under the exclusive control lock. Therefore
        // FILE_NOT_FOUND alone is accepted here only together with those prerequisites.
        if(notify)notify(RecoveryStage::JobTermination);
        NamedJob job(ownership.owner,before.run,true);job.terminateAndWait();
        if(notify)notify(RecoveryStage::Restore);
        journal.advance(Phase::Terminating);journal.advance(Phase::Restoring);Resources::restorePersistent(ownership);
        journal.deleteProfile();Resources::removeSession(ownership,before.run,before.sessionIdentity);journal.clean();
    }
};
}
