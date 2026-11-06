// Deterministic native control tests. No files, profiles, Jobs or processes are
// created/deleted/opened/terminated. SID derivation and hashing are read-only.
#include "../../../apps/backend/native/backend-recovery.h"
#include <cstdint>
#include <utility>

namespace br=backend_runtime;
namespace {
using namespace br;
using Events=std::vector<std::string>;
void check(bool value,const char* label){if(!value)throw WinError(label,ERROR_ASSERTION_FAILURE);}
template<class Action> void rejected(Action action,const char* label){try{action();}catch(const WinError&){return;}throw WinError(label,ERROR_ASSERTION_FAILURE);}
size_t at(const Events& events,const std::string& event){auto found=std::find(events.begin(),events.end(),event);return static_cast<size_t>(found-events.begin());}
size_t count(const Events& events,const std::string& event){return static_cast<size_t>(std::count(events.begin(),events.end(),event));}
const JournalContext context{std::string(64,'a'),"S-1-5-21-100-200-300-1001",std::string(24,'b'),std::string(24,'c')};
JournalRecord fixture(Phase phase=Phase::Prepared,ProcessState state=ProcessState::None,const std::string& profile="OWNED"){
    JournalRecord r;r.phase=phase;r.profileState=profile;r.processState=state;
    if(phase!=Phase::Clean||profile!="NONE"){
        const auto tag=widen(hashBytes(reinterpret_cast<const BYTE*>(context.ownerText.data()),context.ownerText.size()).substr(0,16));
        r.run=std::wstring(32,L'1');r.sessionIdentity=std::string(24,'2');r.job=L"Global\\Tahtiapuri.Backend."+tag+L"."+r.run;
        r.profile=L"tahtiapuri.backend."+tag.substr(0,8)+L"."+r.run;
        if(profile=="OWNED"||profile=="DELETED"){
            ProfileSid sid;HRESULT result=DeriveAppContainerSidFromAppContainerName(r.profile.c_str(),&sid.value);
            check(SUCCEEDED(result)&&sid.value,"fixture-sid-derive");r.sid=sidText(sid.value);
        }
    }
    if(state==ProcessState::Recorded){r.processPid=42;r.processCreationTime=0x0123456789abcdefULL;}return r;
}
std::string altered(const std::string& bytes,size_t field,const std::string& text,bool sign=true){
    auto lines=journalLines(bytes);lines.at(field)=text;std::string body;for(size_t i=0;i+1<lines.size();++i)body+=lines[i]+"\n";
    return body+(sign?hashBytes(reinterpret_cast<const BYTE*>(body.data()),body.size()):lines.back())+"\n";
}
std::string encodedFixture(const JournalRecord& r){
    auto bytes=serializeJournal(fixture(),context);auto optional=[](const std::wstring& value){return value.empty()?std::string("-"):narrow(value);};
    for(const auto& field:std::vector<std::pair<size_t,std::string>>{{7,phaseName(r.phase)},{8,optional(r.run)},{9,optional(r.job)},
        {10,optional(r.profile)},{11,r.sessionIdentity.empty()?"-":r.sessionIdentity},{12,r.profileState},{13,optional(r.sid)},
        {14,processStateName(r.processState)},{15,r.processState==ProcessState::Recorded?std::to_string(r.processPid):"-"},
        {16,r.processState==ProcessState::Recorded?creationTimeText(r.processCreationTime):"-"}})bytes=altered(bytes,field.first,field.second);
    return bytes;
}
struct MemoryJournal final:JournalApi {
    Events& events;std::string bytes,pending;std::string failure,target="CREATING";bool armed=false;
    MemoryJournal(Events& calls,const JournalRecord& record):events(calls),bytes(serializeJournal(record,context)){}
    void verify() override{events.push_back("verify-journal");}
    bool fails(const char* step){return armed&&failure==step&&(target=="ANY"||journalLines(pending)[14]==target);}
    void write(const std::string& text) override{
        pending=text;const auto fields=journalLines(text);events.push_back("write-"+fields[7]);events.push_back("state-"+fields[14]);
        if(fails("write"))throw WinError("injected-write",ERROR_WRITE_FAULT);
    }
    void flush() override{events.push_back("flush");if(fails("flush"))throw WinError("injected-flush",ERROR_WRITE_FAULT);bytes=pending;}
    std::string read() override{events.push_back("readback");if(fails("read"))throw WinError("injected-read",ERROR_READ_FAULT);return fails("mismatch")?bytes+"x":bytes;}
    void deleteProfile(const std::wstring&) override{events.push_back("delete-profile");}
};
struct NativeWitness final:ProcessWitnessApi {
    Events& events;uint64_t time=1000,identity=0x0123456789abcdefULL;DWORD waitResult=WAIT_OBJECT_0;
    bool open=true,snapshotOk=true,queryOk=true,firstOk=true;int nextError=-1;size_t cursor=0;
    std::vector<DWORD> pids{77,88};std::string delayed;bool liveHandle=false;DWORD perCall=0,lastWait=0;
    explicit NativeWitness(Events& calls):events(calls){}
    void call(const std::string& name){events.push_back(name);time+=perCall;if(delayed==name)time+=5000;}
    uint64_t tick() override{return time;}
    HANDLE openProcess(DWORD pid) override{check(pid==42,"witness-pid");call("open-process");liveHandle=open;return open?reinterpret_cast<HANDLE>(ULONG_PTR(1)):nullptr;}
    uint64_t creationTime(HANDLE handle) override{check(liveHandle&&handle==reinterpret_cast<HANDLE>(ULONG_PTR(1)),"query-same-live-handle");call("identity");if(!queryOk)throw WinError("injected-query",ERROR_ACCESS_DENIED);return identity;}
    DWORD wait(HANDLE handle,DWORD timeout) override{check(liveHandle&&handle==reinterpret_cast<HANDLE>(ULONG_PTR(1))&&timeout<=5000&&timeout>0,"wait-same-bounded-live-handle");lastWait=timeout;call("wait");return waitResult;}
    HANDLE snapshot() override{call("snapshot");return snapshotOk?reinterpret_cast<HANDLE>(ULONG_PTR(2)):INVALID_HANDLE_VALUE;}
    bool first(HANDLE,DWORD& pid) override{call("first");if(!firstOk)throw WinError("injected-first",ERROR_ACCESS_DENIED);if(pids.empty())return false;cursor=0;pid=pids[0];return true;}
    bool next(HANDLE,DWORD& pid) override{call("next");if(static_cast<int>(cursor)==nextError)throw WinError("injected-next",ERROR_ACCESS_DENIED);if(++cursor==pids.size()){call("snapshot-complete");return false;}pid=pids[cursor];return true;}
    DWORD ownPid() override{return 77;}
    void close(HANDLE handle) override{if(handle==reinterpret_cast<HANDLE>(ULONG_PTR(1))){check(liveHandle,"handle-close-once");liveHandle=false;call("close-process");}else call("close-snapshot");}
    void pause(DWORD milliseconds) override{time+=milliseconds;}
};
enum class JobCase { Found,Missing,Error };
struct NativeRecovery final:RecoveryApi {
    Events& events;NativeWitness native;JobCase job;bool terminateOk=true;
    NativeRecovery(Events& calls,JobCase mode):events(calls),native(calls),job(mode){}
    ProcessWitnessApi& witness() override{return native;}
    void verify() override{events.push_back("verify-owner");}
    void baseline() override{events.push_back("baseline");}
    bool openJob(const JournalRecord&) override{native.call("open-job");if(job==JobCase::Error)throw WinError("injected-job-open",ERROR_ACCESS_DENIED);return job==JobCase::Found;}
    void terminateJob(TerminationBudget& budget) override{budget.check();native.call("job-proof");if(!terminateOk)throw WinError("injected-job-termination",ERROR_ACCESS_DENIED);budget.check();}
    void restore() override{events.push_back("restore");}
    void removeSession(const JournalRecord&) override{events.push_back("delete-session");}
};
RecoveryNotify phases(Events& events,NativeWitness& native){return [&](RecoveryStage stage,uint64_t deadline){
    events.push_back(stage==RecoveryStage::JobTermination?"phase-job":"phase-restore");
    check(deadline==native.time+(stage==RecoveryStage::JobTermination?5000:15000),"shared-phase-budget");
};}
void noCleanup(const Events& events){
    for(const auto* event:{"write-TERMINATING","write-RESTORING","restore","delete-profile","delete-session","write-CLEAN","phase-restore"})
        check(count(events,event)==0,"blocked-before-first-cleanup-mutation");
}
void successOrder(const Events& events,const std::string& proof){
    check(count(events,"phase-job")==1&&count(events,"phase-restore")==1,"one-proof-phase");
    check(at(events,proof)<at(events,"phase-restore")&&at(events,"phase-restore")<at(events,"write-TERMINATING"),"proof-before-first-journal-mutation");
    check(at(events,"write-RESTORING")<at(events,"restore")&&at(events,"restore")<at(events,"delete-profile")&&
        at(events,"delete-profile")<at(events,"delete-session")&&at(events,"delete-session")<at(events,"write-CLEAN"),"ordered-cleanup");
}
void recoveryCase(ProcessState state,JobCase job,bool succeeds,const std::function<void(NativeRecovery&)>& configure={},Phase phase=Phase::Prepared){
    Events events;MemoryJournal store(events,fixture(phase,state));Journal journal(context,store);NativeRecovery api(events,job);
    if(configure)configure(api);events.clear();const auto original=store.bytes;const auto notify=phases(events,api.native);
    if(succeeds){recoverOwned(journal,api,notify);check(journal.current().phase==Phase::Clean,"success-clean");
        successOrder(events,job==JobCase::Found?"job-proof":state==ProcessState::None?"open-job":api.native.open?"wait":"snapshot-complete");}
    else {rejected([&]{recoverOwned(journal,api,notify);},"unproven-recovery-accepted");noCleanup(events);check(store.bytes==original,"blocked-journal-unchanged");}
    check(count(events,"snapshot")<=1,"one-snapshot-only");
}
void witnessCases(){
    for(auto state:{ProcessState::None,ProcessState::Creating,ProcessState::Recorded})for(auto job:{JobCase::Found,JobCase::Missing,JobCase::Error})
        recoveryCase(state,job,job==JobCase::Found||(job==JobCase::Missing&&state!=ProcessState::Creating));
    for(DWORD result:std::array<DWORD,3>{WAIT_TIMEOUT,WAIT_FAILED,WAIT_ABANDONED})recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[&](NativeRecovery& api){api.native.waitResult=result;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){++api.native.identity;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.queryOk=false;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,true,[](NativeRecovery& api){api.native.open=false;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.pids={77,42,88};});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.pids={88};});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.pids={};});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.snapshotOk=false;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.firstOk=false;});
    for(int index:{0,1})recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[&](NativeRecovery& api){api.native.open=false;api.native.nextError=index;});
    for(const auto* delayed:{"open-job","open-process","identity","wait","snapshot","first","next","snapshot-complete"})
        recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[&](NativeRecovery& api){api.native.delayed=delayed;api.native.open=std::string(delayed)=="open-job"||std::string(delayed)=="open-process"||std::string(delayed)=="identity"||std::string(delayed)=="wait";});
    recoveryCase(ProcessState::None,JobCase::Found,false,[](NativeRecovery& api){api.terminateOk=false;});
    recoveryCase(ProcessState::Recorded,JobCase::Found,false,[](NativeRecovery& api){api.native.delayed="job-proof";});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.perCall=1300;});
    recoveryCase(ProcessState::Recorded,JobCase::Missing,false,[](NativeRecovery& api){api.native.open=false;api.native.perCall=1000;});
    {Events events;MemoryJournal store(events,fixture(Phase::Prepared,ProcessState::Recorded));Journal journal(context,store);NativeRecovery api(events,JobCase::Missing);
        api.native.perCall=500;recoverOwned(journal,api);check(api.native.lastWait==3500,"open-and-query-consume-wait-budget");}
    // An uncertain create remains blocked throughout cleanup phases too.
    for(auto phase:{Phase::Terminating,Phase::Restoring,Phase::ProfileDeleted}){
        Events events;auto record=fixture(phase,ProcessState::Creating,phase==Phase::ProfileDeleted?"DELETED":"OWNED");
        MemoryJournal store(events,record);Journal journal(context,store);NativeRecovery api(events,JobCase::Missing);events.clear();
        rejected([&]{recoverOwned(journal,api,phases(events,api.native));},"cleanup-creating-accepted");noCleanup(events);
    }
    for(auto phase:{Phase::Preparing,Phase::ProfileOwned}){
        Events calls;MemoryJournal memory(calls,fixture(phase,ProcessState::None,phase==Phase::Preparing?"NONE":"OWNED"));
        Journal log(context,memory);NativeRecovery native(calls,JobCase::Missing);calls.clear();recoverOwned(log,native,phases(calls,native.native));
        check(log.current().phase==Phase::Clean&&at(calls,"open-job")<at(calls,"restore")&&count(calls,"open-process")==0&&count(calls,"snapshot")==0,"certain-precreate-recovery");
    }
    {Events calls;MemoryJournal memory(calls,fixture(Phase::ProfileCreating,ProcessState::None,"CREATING"));Journal log(context,memory);NativeRecovery native(calls,JobCase::Found);calls.clear();
        rejected([&]{recoverOwned(log,native,phases(calls,native.native));},"ambiguous-profile-recovered");noCleanup(calls);check(count(calls,"open-job")==0,"profile-ambiguity-before-proof");}
    Events events;MemoryJournal store(events,fixture(Phase::Clean,ProcessState::None,"NONE"));Journal journal(context,store);NativeRecovery api(events,JobCase::Error);events.clear();
    recoverOwned(journal,api);check(events==Events({"verify-owner","baseline"}),"clean-baseline-only");
}
void parserCases(){
    for(auto phase:{Phase::Clean,Phase::Preparing,Phase::ProfileCreating,Phase::ProfileOwned,Phase::Prepared,Phase::Running,Phase::Closing,Phase::Terminating,Phase::Restoring,Phase::ProfileDeleted})
        for(auto state:{ProcessState::None,ProcessState::Creating,ProcessState::Recorded})for(const auto* profile:{"NONE","CREATING","OWNED","DELETED"}){
            const bool statePhase=(phase!=Phase::Clean&&phase!=Phase::Preparing&&phase!=Phase::ProfileCreating&&phase!=Phase::ProfileOwned)||state==ProcessState::None;
            const bool running=(phase!=Phase::Running&&phase!=Phase::Closing)||state==ProcessState::Recorded;
            const std::string profileText=profile;const bool processProfile=state==ProcessState::None||profileText=="OWNED"||profileText=="DELETED";
            bool profilePhase=true;
            if(phase==Phase::Clean||phase==Phase::Preparing)profilePhase=profileText=="NONE";
            else if(phase==Phase::ProfileCreating)profilePhase=profileText=="CREATING";
            else if(phase==Phase::ProfileOwned||phase==Phase::Prepared||phase==Phase::Running||phase==Phase::Closing)profilePhase=profileText=="OWNED";
            else if(phase==Phase::ProfileDeleted)profilePhase=profileText=="DELETED";
            const auto record=fixture(phase,state,profile);const bool valid=statePhase&&running&&processProfile&&profilePhase;
            if(valid){const auto bytes=serializeJournal(record,context);check(journalLines(bytes).size()==18,"v2-18-fields");check(serializeJournal(parseJournal(bytes,context),context)==bytes,"v2-roundtrip");}
            else {rejected([&]{serializeJournal(record,context);},"invalid-phase-combination-serialized");
                rejected([&]{parseJournal(encodedFixture(record),context);},"invalid-phase-combination-parsed");}
        }
    const auto bytes=serializeJournal(fixture(Phase::Prepared,ProcessState::Recorded),context);
    check(journalLines(bytes)[16]=="0123456789abcdef","full-filetime-canonical");
    for(const auto* value:{"0","00","01","-1","+1","4294967296","99999999999","1 ","x"})rejected([&]{parseJournal(altered(bytes,15,value),context);},"invalid-pid-parsed");
    for(const auto* value:{"0000000000000000","0123456789ABCDEf","123456789abcdef","00123456789abcdef","-","gggggggggggggggg"})rejected([&]{parseJournal(altered(bytes,16,value),context);},"invalid-filetime-parsed");
    for(const auto* value:{"1","4294967295"})check(parseJournal(altered(bytes,15,value),context).processPid==parseProcessPid(value),"pid-endpoints");
    check(parseJournal(altered(bytes,16,"ffffffffffffffff"),context).processCreationTime==UINT64_MAX,"filetime-maximum");
    for(const auto* value:{"","UNKNOWN","none"})rejected([&]{parseJournal(altered(bytes,14,value),context);},"unknown-state-parsed");
    rejected([&]{parseJournal(altered(bytes,0,"TAHTIAPURI_BACKEND_JOURNAL_V3"),context);},"unknown-version-parsed");
    rejected([&]{parseJournal(altered(bytes,7,"UNKNOWN"),context);},"unknown-phase-parsed");
    rejected([&]{parseJournal(altered(bytes,12,"UNKNOWN"),context);},"unknown-profile-state-parsed");
    for(size_t field:{size_t(1),size_t(2),size_t(3),size_t(4),size_t(5),size_t(6),size_t(8),size_t(9),size_t(10),size_t(11),size_t(13)})
        rejected([&]{parseJournal(altered(bytes,field,"wrong"),context);},"identity-contract-change-parsed");
    rejected([&]{parseJournal(altered(bytes,15,"43",false),context);},"bad-checksum-parsed");
    rejected([&]{parseJournal(bytes+"extra\n",context);},"extra-field-parsed");
    rejected([&]{parseJournal(bytes.substr(0,bytes.size()-1),context);},"missing-lf-parsed");
    std::string crlf=bytes;crlf.insert(crlf.find('\n'),1,'\r');rejected([&]{parseJournal(crlf,context);},"crlf-parsed");
    rejected([&]{parseJournal(std::string(4097,'x'),context);},"oversize-parsed");
    const auto clean=serializeJournal(fixture(Phase::Clean,ProcessState::None,"NONE"),context);
    for(const auto& current:{clean,bytes}){
        rejected([&]{parseJournal(altered(current,0,"TAHTIAPURI_BACKEND_JOURNAL_V1"),context);},"v1-tag-parsed");
        auto lines=journalLines(current);std::string legacy="TAHTIAPURI_BACKEND_JOURNAL_V1\n";for(size_t i=1;i<14;++i)legacy+=lines[i]+"\n";
        legacy+=hashBytes(reinterpret_cast<const BYTE*>(legacy.data()),legacy.size())+"\n";
        rejected([&]{parseJournal(legacy,context);},"legacy-v1-parsed");
    }
    for(auto state:{ProcessState::None,ProcessState::Creating}){
        const auto empty=serializeJournal(fixture(Phase::Prepared,state),context);
        rejected([&]{parseJournal(altered(empty,15,"42"),context);},"unrecorded-pid-parsed");
        rejected([&]{parseJournal(altered(empty,16,"0123456789abcdef"),context);},"unrecorded-filetime-parsed");
    }
}
void commitCases(){
    for(const auto* target:{"CREATING","RECORDED"})for(const auto* failure:{"write","flush","read","mismatch"}){
        Events events;MemoryJournal store(events,fixture());Journal journal(context,store);NativeRecovery api(events,JobCase::Found);
        store.target=target;store.failure=failure;store.armed=true;events.clear();unsigned creates=0,resumes=0;
        auto create=[&]{events.push_back("create-suspended");++creates;};auto identity=[&]{events.push_back("created-identity");return std::make_pair(DWORD(42),0x0123456789abcdefULL);};
        rejected([&]{createRecordedProcess(journal,create,identity);},"failed-commit-start-accepted");
        check(creates==(std::string(target)=="CREATING"?0U:1U),"durable-creating-before-create");
        rejected([&]{resumeRecordedProcess(journal,[&]{++resumes;});},"poison-resumed");
        const auto writes=count(events,"write-PREPARED");
        rejected([&]{createRecordedProcess(journal,create,identity);},"poison-created-again");
        rejected([&]{journal.advance(Phase::Terminating);},"poison-advanced");
        rejected([&]{journal.clean();},"poison-cleaned");
        // This executes the same current-instance cleanup used by the broker.
        // The verified Job is terminated even though every journal operation fails.
        rejected([&]{cleanupCurrent(journal,api,phases(events,api.native));},"poison-cleanup-accepted");
        check(count(events,"job-proof")==1&&count(events,"write-PREPARED")==writes&&resumes==0,"poison-termination-without-commits-resume");noCleanup(events);
    }
    for(const auto* fault:{"create","identity"}){
        Events events;MemoryJournal store(events,fixture());Journal journal(context,store);unsigned creates=0,resumes=0;
        auto create=[&]{++creates;if(std::string(fault)=="create")throw WinError("injected-create",ERROR_GEN_FAILURE);};
        auto identity=[&]()->std::pair<DWORD,uint64_t>{throw WinError("injected-identity",ERROR_ACCESS_DENIED);};
        rejected([&]{createRecordedProcess(journal,create,identity);},"failed-create-accepted");
        check(journal.current().processState==ProcessState::Creating&&parseJournal(store.bytes,context).processState==ProcessState::Creating,"failed-create-remains-creating");
        rejected([&]{createRecordedProcess(journal,create,identity);},"second-create-accepted");
        rejected([&]{resumeRecordedProcess(journal,[&]{++resumes;});},"creating-resumed");check(creates==1&&resumes==0,"one-create-no-resume");
    }
    // Poison on the first post-proof cleanup commit must still have terminated
    // the current Job, and must not restore/delete anything afterwards.
    Events events;MemoryJournal store(events,fixture(Phase::Running,ProcessState::Recorded));Journal journal(context,store);NativeRecovery api(events,JobCase::Found);
    store.target="ANY";store.failure="flush";store.armed=true;events.clear();
    rejected([&]{cleanupCurrent(journal,api);},"cleanup-commit-failure-accepted");
    check(at(events,"job-proof")<at(events,"write-TERMINATING")&&count(events,"restore")==0&&count(events,"delete-profile")==0&&count(events,"delete-session")==0&&count(events,"write-CLEAN")==0,"failed-advance-still-terminates-before-restore");
}
void launchOrder(){
    Events events;MemoryJournal store(events,fixture());Journal journal(context,store);events.clear();
    rejected([&]{journal.advance(Phase::Running);},"running-before-recorded");
    // Invalid commit validation itself poisons; use a fresh instance for launch.
    Events launch;MemoryJournal safe(launch,fixture());Journal start(context,safe);launch.clear();
    createRecordedProcess(start,[&]{check(parseJournal(safe.bytes,context).processState==ProcessState::Creating,"creating-readback-before-api");launch.push_back("create-suspended");},
        [&]{launch.push_back("identity");return std::make_pair(DWORD(42),0x0123456789abcdefULL);});
    start.requireRecorded();launch.push_back("prepared");launch.push_back("start");
    resumeRecordedProcess(start,[&]{check(parseJournal(safe.bytes,context).processState==ProcessState::Recorded,"recorded-before-resume");launch.push_back("resume");});
    check(at(launch,"state-CREATING")<at(launch,"create-suspended")&&at(launch,"create-suspended")<at(launch,"identity")&&at(launch,"identity")<at(launch,"state-RECORDED"),"creation-transition-order");
    check(at(launch,"state-RECORDED")<at(launch,"prepared")&&at(launch,"prepared")<at(launch,"start")&&at(launch,"start")<at(launch,"resume"),"recorded-before-external-start");
    check(count(launch,"flush")==2&&count(launch,"readback")==2,"both-commits-flush-readback");
    rejected([&]{start.creatingProcess();},"recorded-to-creating-accepted");start.advance(Phase::Running);start.advance(Phase::Closing);
}
}
int wmain(){
    try{parserCases();witnessCases();commitCases();launchOrder();emit("{\"passed\":true,\"suite\":\"native-process-witness-v1\"}");return 0;}
    catch(const WinError& error){emit("{\"passed\":false,\"stage\":\""+std::string(error.what())+"\",\"error\":"+std::to_string(error.code)+"}");return 1;}
    catch(...){emit("{\"passed\":false,\"stage\":\"unexpected-exception\"}");return 1;}
}
