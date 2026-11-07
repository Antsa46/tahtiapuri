#pragma once
#include "broker-clean-release-codec.h"
#include "broker-release.h"

namespace mcp_runtime {
// A separate bounded SHA adapter keeps the original journal's1024-byte limit.
// The clean intent hashes its whole2048 bytes when bound to the completion.
inline std::array<uint8_t,32> cleanReleaseDigest(const uint8_t* bytes,size_t size){
    if(!bytes||size>brokerCleanIntentBytes)throw WinError("mcp-clean-release-sha-size",ERROR_INVALID_PARAMETER);
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<uint8_t,32> digest={};
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("mcp-clean-release-sha-open");
    auto status=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0);
    if(status>=0)status=BCryptHashData(hash,const_cast<PUCHAR>(bytes),static_cast<ULONG>(size),0);
    if(status>=0)status=BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0);
    if(hash)BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm,0);
    if(status<0)throw WinError("mcp-clean-release-sha");
    return digest;
}
inline void requireCleanProfileIdentity(const BrokerCleanReleaseIntent& record,uint64_t deadline){
    requireSessionBudget(deadline);
    const auto name=L"tahtiapuri.mcp."+hex(record.session.generation.data(),record.session.generation.size());
    PSID raw=nullptr;const auto result=DeriveAppContainerSidFromAppContainerName(name.c_str(),&raw);
    if(FAILED(result))throw WinError("mcp-clean-release-profile-derive",static_cast<DWORD>(result));
    struct SidGuard{PSID value;~SidGuard(){if(value)FreeSid(value);}} guard{raw};
    if(!raw||!IsValidSid(raw)||ascii(windows_runtime::sidText(raw))!=record.journal.profileSid)
        throw WinError("mcp-clean-release-profile-identity",ERROR_INVALID_SID);
    // Derivation checks the generation's identity, never profile/storage absence.
    requireSessionBudget(deadline);
}
inline void requireCleanJobAbsent(const BrokerCleanReleaseIntent& record,windows_runtime::TerminationBudget& budget){
    budget.check();const auto name=L"Global\\Tahtiapuri.Mcp."+hex(record.session.generation.data(),record.session.generation.size());
    Handle job(OpenJobObjectW(JOB_OBJECT_QUERY|READ_CONTROL,FALSE,name.c_str()));
    const DWORD error=job.value?ERROR_SUCCESS:GetLastError();budget.check();
    if(job.value){
        // An empty existing Job also refuses this happy path. No creation,
        // configuration or termination rights are requested by this observer.
        const auto raw=job.value;job.value=nullptr;
        if(!CloseHandle(raw))throw WinError("mcp-clean-release-job-close");
        throw WinError("mcp-clean-release-job-present",ERROR_BUSY);
    }
    if(error!=ERROR_FILE_NOT_FOUND)throw WinError("mcp-clean-release-job-uncertain",error);
    budget.check();
}
inline void proveCleanReleaseExitState(const BrokerCleanReleaseIntent& record,
    windows_runtime::ProcessWitnessApi& processes,windows_runtime::TerminationBudget& budget){
    // Exact creation+signaled retained handle, or one complete process-only
    // snapshot with ownPID present and recordedPID absent. PID reuse refuses.
    windows_runtime::proveRecordedProcessExit(processes,budget,record.journal.broker.pid,record.journal.broker.creationTime);
    windows_runtime::proveRecordedProcessExit(processes,budget,record.journal.worker.pid,record.journal.worker.creationTime);
    requireCleanJobAbsent(record,budget);
}
class NativeCleanInventory {
    BootstrapDirectoryGuard& control;
    const BrokerSessionRecord session;
    std::array<std::wstring,2> paths;
    std::array<std::unique_ptr<BootstrapPin>,2> pins;
    JournalBytes sourceJournal={};JournalFileIdentity journalFile={};size_t cursor=0;
    void verifyShape(){
        control.verify();
        if(cursor==2){requireBootstrapAbsent(paths[1]);return;}
        auto& reservation=*pins[1];reservation.verify();
        resourceAcl(reservation,control.owner,nullptr,0,true,false,true);
        if(!journalIdentityEqual(session.reservation,sessionFileIdentity(reservation.initial)))
            throw WinError("mcp-clean-release-reservation-changed",ERROR_ACCESS_DENIED);
        requireBootstrapAbsent(paths[1]+L"\\worker");
        if(cursor==0){
            auto& journal=*pins[0];journal.verify();requireBootstrapAcl(journal.handle.value,control.owner,false);
            if(!journalIdentityEqual(journalFile,sessionFileIdentity(journal.initial))||sessionReadBytes<brokerJournalBytes>(journal)!=sourceJournal)
                throw WinError("mcp-clean-release-journal-changed",ERROR_ACCESS_DENIED);
            exactChildren(paths[1],{L"broker-journal.bin"});
        }else{requireBootstrapAbsent(paths[0]);exactChildren(paths[1],{});}
        control.verify();
    }
public:
    NativeCleanInventory(BootstrapDirectoryGuard& guard,const BrokerSessionRecord& original,const BrokerCleanReleaseIntent* expected)
        :control(guard),session(original),paths{guard.root+L"\\native-session-reserved\\broker-journal.bin",guard.root+L"\\native-session-reserved"}{
        // Pin the parent first. A specifically absent reservation implies its
        // journal is absent; PATH_NOT_FOUND is not accepted as direct evidence.
        std::array<bool,2> present={};present[1]=releaseEntryPresent(paths[1]);
        if(present[1]){
            pins[1]=std::make_unique<BootstrapPin>(paths[1],true,DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY,OPEN_EXISTING,FILE_SHARE_READ);
            resourceAcl(*pins[1],control.owner,nullptr,0,true,false,true);
            if(!journalIdentityEqual(session.reservation,sessionFileIdentity(pins[1]->initial)))
                throw WinError("mcp-clean-release-reservation",ERROR_ACCESS_DENIED);
            requireBootstrapAbsent(paths[1]+L"\\worker");present[0]=releaseEntryPresent(paths[0]);
            if(present[0]){
                pins[0]=std::make_unique<BootstrapPin>(paths[0],false,DELETE|GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,OPEN_EXISTING,FILE_SHARE_READ);
                requireBootstrapAcl(pins[0]->handle.value,control.owner,false);
                sourceJournal=sessionReadBytes<brokerJournalBytes>(*pins[0]);journalFile=sessionFileIdentity(pins[0]->initial);
                const auto parsed=decodeBrokerJournal(sourceJournal.data(),sourceJournal.size(),cleanReleaseDigest);
                if(encodeBrokerJournal(parsed,cleanReleaseDigest)!=sourceJournal)throw WinError("mcp-clean-release-journal-canonical",ERROR_INVALID_DATA);
                if(expected&&(sourceJournal!=encodeBrokerJournal(expected->journal,cleanReleaseDigest)
                   ||cleanReleaseDigest(sourceJournal.data(),sourceJournal.size())!=expected->journalDigest
                   ||!journalIdentityEqual(journalFile,expected->journalFile)))
                    throw WinError("mcp-clean-release-journal-context",ERROR_ACCESS_DENIED);
            }
        }
        cursor=brokerCleanReleasePrefix(present);
        if(!expected&&cursor!=0)throw WinError("mcp-clean-release-initial-tree",ERROR_INVALID_STATE);
        verifyShape();
    }
    const JournalBytes& journalBytes()const{
        if(cursor!=0)throw WinError("mcp-clean-release-no-source-journal",ERROR_INVALID_STATE);
        return sourceJournal;
    }
    JournalFileIdentity journalIdentity()const{return journalFile;}
    size_t frontier()const{return cursor;}
    void verify(){verifyShape();}
    void removeNext(uint64_t deadline){
        if(cursor>=pins.size())throw WinError("mcp-clean-release-already-removed",ERROR_INVALID_STATE);
        verifyShape();auto& pin=*pins[cursor];FILE_DISPOSITION_INFO disposition={TRUE};requireSessionBudget(deadline);
        if(!SetFileInformationByHandle(pin.handle.value,FileDispositionInfo,&disposition,sizeof(disposition)))
            throw WinError("mcp-clean-release-delete");
        closeBootstrapHandle(pin);pins[cursor].reset();
        // A retained reader/delete-pending or any uncertain query stops the
        // prefix. The next target is never touched before definite absence.
        control.verify();requireBootstrapAbsent(paths[cursor]);++cursor;verifyShape();
    }
};
inline void requireCleanReleaseControlShape(BootstrapDirectoryGuard& control,size_t frontier,bool completed){
    std::vector<std::wstring> expected={sessionLeaseLeaf,sessionRecordLeaf,sessionCleanReleaseLeaf};
    if(frontier<2)expected.push_back(L"native-session-reserved");
    if(completed)expected.push_back(sessionCleanReleasedLeaf);
    exactChildren(control.root,expected);
}
inline void releaseCleanBrokerSession(const std::wstring& path,const MainBootstrap& bootstrap,
    uint64_t deadline,const std::function<void(size_t)>& afterBoundary={},
    const NativeCleanIntentRecordIo& intentIo=windowsCleanIntentRecordIo(),
    const NativeReleaseRecordIo& completionIo=windowsReleaseRecordIo(),
    windows_runtime::ProcessWitnessApi& processes=windows_runtime::windowsProcessWitnessApi()){
    if(!deadline)throw WinError("mcp-clean-release-deadline",ERROR_INVALID_PARAMETER);
    requireSessionBudget(deadline);requirePublishingMain(bootstrap);BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,false);
    requireNoPristineBrokerRelease(control);
    BootstrapPin state(control.root+L"\\"+sessionRecordLeaf,false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,OPEN_EXISTING,0);
    requireBootstrapAcl(state.handle.value,control.owner,false);
    // Validate the physical FULL source bytes before the intent compresses the
    // canonical session prefix. Never normalize malformed reserved bytes first.
    const auto sessionBytes=sessionReadBytes<brokerJournalBytes>(state);
    const auto session=decodeBrokerSession(sessionBytes.data(),sessionBytes.size(),cleanReleaseDigest);
    if(encodeBrokerSession(session,cleanReleaseDigest)!=sessionBytes)throw WinError("mcp-clean-release-session-canonical",ERROR_INVALID_DATA);
    requireSessionContext(session,control,lease,bootstrap);
    if(session.phase!=SessionPhase::BrokerAdmitted)throw WinError("mcp-clean-release-not-admitted",ERROR_INVALID_STATE);
    const auto sessionDigest=cleanReleaseDigest(sessionBytes.data(),sessionBytes.size());
    auto recheck=[&]{
        requireSessionBudget(deadline);requirePublishingMain(bootstrap);control.verify();lease.verify();state.verify();
        requireBootstrapAcl(state.handle.value,control.owner,false);requireNoPristineBrokerRelease(control);
        if(sessionReadBytes<brokerJournalBytes>(state)!=sessionBytes)throw WinError("mcp-clean-release-session-changed",ERROR_ACCESS_DENIED);
        requireBootstrapAbsent(control.path);requireBootstrapAbsent(control.root+L"\\main-bootstrap.pending");requireSessionBudget(deadline);
    };
    recheck();const bool priorIntent=releaseEntryPresent(control.root+L"\\"+sessionCleanReleaseLeaf);
    const bool priorCompletion=releaseEntryPresent(control.root+L"\\"+sessionCleanReleasedLeaf);
    if(priorCompletion&&!priorIntent)throw WinError("mcp-clean-release-orphan-completion",ERROR_INVALID_STATE);
    std::unique_ptr<NativeCleanIntentRecord> intent;BrokerCleanReleaseIntent record;CleanIntentBytes intentBytes={};
    if(priorIntent){
        intent=std::make_unique<NativeCleanIntentRecord>(control,sessionCleanReleaseLeaf,false,deadline,intentIo);intentBytes=intent->read();
        record=decodeBrokerCleanReleaseIntent(intentBytes.data(),intentBytes.size(),cleanReleaseDigest);
        if(encodeBrokerSession(record.session,cleanReleaseDigest)!=sessionBytes||record.sessionDigest!=sessionDigest
           ||!journalIdentityEqual(record.sessionFile,sessionFileIdentity(state.initial))||!journalIdentityEqual(record.intentFile,intent->identity()))
            throw WinError("mcp-clean-release-intent-context",ERROR_ACCESS_DENIED);
    }
    NativeCleanInventory inventory(control,session,priorIntent?&record:nullptr);
    if(!priorIntent){
        record.session=session;record.sessionFile=sessionFileIdentity(state.initial);record.sessionDigest=sessionDigest;
        const auto& journal=inventory.journalBytes();record.journal=decodeBrokerJournal(journal.data(),journal.size(),cleanReleaseDigest);
        record.journalFile=inventory.journalIdentity();record.journalDigest=cleanReleaseDigest(journal.data(),journal.size());
        // Own identity exists only after CREATE_NEW. Validate the source
        // without inventing an intent identity; the full encoder then checks
        // the actual new file's identity before any bytes or targets change.
        validateBrokerCleanReleaseSource(record);
    }
    requireCleanProfileIdentity(record,deadline);
    // One shared budget, capped by the already-running native5s deadline. No
    // witness, prefix or retry within this operation receives a fresh5s period.
    windows_runtime::TerminationBudget budget(processes,deadline);
    auto freshWitnesses=[&]{recheck();budget.check();proveCleanReleaseExitState(record,processes,budget);budget.check();recheck();};
    freshWitnesses();
    if(!priorIntent){
        exactChildren(control.root,{sessionLeaseLeaf,sessionRecordLeaf,L"native-session-reserved"});
        recheck();inventory.verify();intent=std::make_unique<NativeCleanIntentRecord>(control,sessionCleanReleaseLeaf,true,deadline,intentIo);
        record.intentFile=intent->identity();intentBytes=encodeBrokerCleanReleaseIntent(record,cleanReleaseDigest);intent->writeNew(intentBytes,deadline);
    }
    requireCleanReleaseControlShape(control,inventory.frontier(),priorCompletion);
    BrokerCleanReleaseCompletion completion;completion.owner.intentDigest=cleanReleaseDigest(intentBytes.data(),intentBytes.size());
    completion.owner.intentFile=intent->identity();completion.owner.control=session.control;completion.owner.lease=session.lease;
    completion.owner.main=session.main;completion.owner.generation=session.generation;completion.owner.sessionDigest=sessionDigest;
    completion.journalFile=record.journalFile;completion.journalDigest=record.journalDigest;
    const auto completionBytes=encodeBrokerCleanReleaseCompletion(completion,cleanReleaseDigest);
    std::unique_ptr<NativeReleaseRecord> done;
    if(priorCompletion){
        if(inventory.frontier()!=2)throw WinError("mcp-clean-release-premature-completion",ERROR_INVALID_STATE);
        done=std::make_unique<NativeReleaseRecord>(control,sessionCleanReleasedLeaf,false,deadline,completionIo);
        const auto prior=done->read();(void)decodeBrokerCleanReleaseCompletion(prior.data(),prior.size(),cleanReleaseDigest);
        if(prior!=completionBytes)throw WinError("mcp-clean-release-completion-context",ERROR_ACCESS_DENIED);
        intent->durable(intentBytes,deadline);done->durable(completionBytes,deadline);
    }else{
        intent->durable(intentBytes,deadline);recheck();inventory.verify();
        // Internal compile-time seam, never a CLI/env-selected fault mode.
        if(afterBoundary)afterBoundary(inventory.frontier());
        while(inventory.frontier()<2){
            freshWitnesses();requireCleanReleaseControlShape(control,inventory.frontier(),false);
            inventory.removeNext(deadline);if(afterBoundary)afterBoundary(inventory.frontier());
        }
        freshWitnesses();inventory.verify();requireCleanReleaseControlShape(control,2,false);
        done=std::make_unique<NativeReleaseRecord>(control,sessionCleanReleasedLeaf,true,deadline,completionIo);done->writeNew(completionBytes,deadline);
    }
    recheck();inventory.verify();requireCleanReleaseControlShape(control,2,true);
    done->close();intent->close();state.verify();closeBootstrapHandle(state);lease.close();requireSessionBudget(deadline);
}
}
