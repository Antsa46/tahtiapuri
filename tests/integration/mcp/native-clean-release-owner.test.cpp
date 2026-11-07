// Windows filesystem/control integration, not an OS process-exit inspector.
// Process witnesses are injected. No application broker/worker/profile/model
// runs. One unique empty test Job is created only for the presence refusal.
#include "../../../apps/mcp/native/broker-clean-release.h"
#include <cstdio>
#include <iostream>
#include <atomic>
#include <exception>
#include <thread>

namespace {
using namespace mcp_runtime;
size_t cases=0,fixtures=0;
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
template<class Action> void fails(Action action,const char* expected){
    try{action();}catch(const std::exception& e){check(std::string(e.what())==expected,"unexpected-rejection");return;}
    throw std::runtime_error("accepted-invalid-owner-action");
}
template<class Action> void scenario(const char* name,Action action){
    try{action();++cases;}catch(const std::exception& e){throw std::runtime_error(std::string(name)+": "+e.what());}
}
template<size_t Size> void save(const std::wstring& path,const std::array<uint8_t,Size>& bytes,bool create=false){
    BootstrapPin file(path,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,create?CREATE_NEW:OPEN_EXISTING,0);
    sessionWriteBytes(file,bytes);closeBootstrapHandle(file);
}
template<size_t Size> std::array<uint8_t,Size> read(const std::wstring& path){
    BootstrapPin file(path,false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,OPEN_EXISTING,0);
    const auto bytes=sessionReadBytes<Size>(file);closeBootstrapHandle(file);return bytes;
}
void close(Handle& handle){const auto raw=handle.value;handle.value=nullptr;check(CloseHandle(raw)!=FALSE,"test-handle-close");}
struct Processes final:windows_runtime::ProcessWitnessApi {
    enum class Fault{None,BrokerIdentity,WorkerIdentity,LiveBroker,LiveWorker,MissingSelf,RecordedPresent,SnapshotAbsent};
    Fault fault=Fault::None;unsigned opened=0,closed=0,snapshots=0;size_t position=0;
    uint64_t lastTick=0,firstWaitTick=0;DWORD firstWaitBudget=0;unsigned waits=0;
    uint64_t tick()override{lastTick=GetTickCount64();return lastTick;}
    static constexpr DWORD broker=0x70000001,worker=0x70000002;
    static constexpr uint64_t brokerTime=101,workerTime=202;
    HANDLE openProcess(DWORD pid)override{
        check(pid==broker||pid==worker,"unexpected-process-pid");
        if(fault==Fault::MissingSelf||fault==Fault::RecordedPresent||fault==Fault::SnapshotAbsent){SetLastError(ERROR_ACCESS_DENIED);return nullptr;}
        ++opened;return reinterpret_cast<HANDLE>(pid==broker?uintptr_t(11):uintptr_t(12));
    }
    uint64_t creationTime(HANDLE value)override{
        if(value==reinterpret_cast<HANDLE>(uintptr_t(11)))return brokerTime+(fault==Fault::BrokerIdentity?1:0);
        check(value==reinterpret_cast<HANDLE>(uintptr_t(12)),"unexpected-process-handle");return workerTime+(fault==Fault::WorkerIdentity?1:0);
    }
    DWORD wait(HANDLE value,DWORD milliseconds)override{
        if(waits++==0){firstWaitTick=lastTick;firstWaitBudget=milliseconds;}
        if((value==reinterpret_cast<HANDLE>(uintptr_t(11))&&fault==Fault::LiveBroker)
           ||(value==reinterpret_cast<HANDLE>(uintptr_t(12))&&fault==Fault::LiveWorker))return WAIT_TIMEOUT;
        return WAIT_OBJECT_0;
    }
    HANDLE snapshot()override{++opened;++snapshots;position=0;return reinterpret_cast<HANDLE>(uintptr_t(13));}
    bool first(HANDLE value,DWORD& pid)override{
        check(value==reinterpret_cast<HANDLE>(uintptr_t(13)),"unexpected-snapshot-handle");
        pid=fault==Fault::MissingSelf?0:ownPid();return true;
    }
    bool next(HANDLE,DWORD& pid)override{
        if(position++==0){pid=fault==Fault::RecordedPresent?broker:0;return true;}return false;
    }
    void close(HANDLE)override{++closed;}
    void balanced()const{check(opened==closed,"unclosed-test-witness-handle");}
};
struct Fixture {
    std::wstring root,path,reservation,journalPath;MainBootstrap bootstrap;
    BrokerSessionRecord session;BrokerJournalRecord journal;Processes processes;
    JournalBytes originalSession={},originalJournal={};
    explicit Fixture(const std::wstring& parent){
        root=parent+L"\\case-"+std::to_wstring(++fixtures);path=root+L"\\main-bootstrap.bin";
        reservation=root+L"\\native-session-reserved";journalPath=reservation+L"\\broker-journal.bin";
        BootstrapOwner owner;const auto sid=windows_runtime::sidText(owner.sid());
        const auto sddl=L"O:"+sid+L"D:P(A;OICI;FA;;;"+sid+L")(A;OICI;FA;;;SY)";
        windows_runtime::LocalMemory security;
        check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&security.value),nullptr)!=FALSE,"test-root-security");
        SECURITY_ATTRIBUTES attributes={sizeof(attributes),security.value,FALSE};
        check(CreateDirectoryW(extended(root).c_str(),&attributes)!=FALSE,"test-root-create");
        check(CreateDirectoryW(extended(reservation).c_str(),nullptr)!=FALSE,"test-reservation-create");
        const auto stage=reservation+L"\\worker";check(CreateDirectoryW(extended(stage).c_str(),nullptr)!=FALSE,"test-stage-create");
        BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,true);
        bootstrap.main={GetCurrentProcessId(),windows_runtime::windowsProcessWitnessApi().creationTime(GetCurrentProcess())};
        check(BCryptGenRandom(nullptr,bootstrap.generation.data(),static_cast<ULONG>(bootstrap.generation.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)>=0,"test-generation-random");
        bootstrap.pipeNonce=bootstrap.generation;bootstrap.launchToken.fill(0x5a);
        session.phase=SessionPhase::BrokerAdmitted;session.main={bootstrap.main.pid,bootstrap.main.creationTime};
        session.broker={Processes::broker,Processes::brokerTime};session.generation=bootstrap.generation;
        session.descriptorDigest=sessionDescriptorDigest(bootstrap);session.packageDigest=runtimePackageDigest;session.ownerSid=ascii(sid);
        session.control=sessionFileIdentity(control.directory->initial);session.lease=sessionFileIdentity(lease.identity());
        BootstrapPin reservationPin(reservation,true,READ_CONTROL|FILE_READ_ATTRIBUTES);
        BootstrapPin stagePin(stage,true,READ_CONTROL|FILE_READ_ATTRIBUTES);
        session.reservation=sessionFileIdentity(reservationPin.initial);session.stage=sessionFileIdentity(stagePin.initial);
        closeBootstrapHandle(stagePin);check(RemoveDirectoryW(extended(stage).c_str())!=FALSE,"test-stage-remove");
        closeBootstrapHandle(reservationPin);
        NativeSessionFile state(control,lease,true);state.commit(session);state.close();lease.close();
        journal.phase=BrokerPhase::Clean;journal.main=session.main;journal.broker=session.broker;
        journal.worker={Processes::worker,Processes::workerTime};journal.generation=session.generation;
        journal.stage=session.stage;journal.reservation=session.reservation;journal.packageDigest=session.packageDigest;journal.ownerSid=session.ownerSid;
        const auto profile=L"tahtiapuri.mcp."+hex(bootstrap.generation.data(),bootstrap.generation.size());PSID raw=nullptr;
        const auto derived=DeriveAppContainerSidFromAppContainerName(profile.c_str(),&raw);
        if(FAILED(derived))throw WinError("test-profile-derive",static_cast<DWORD>(derived));
        struct SidGuard{PSID value;~SidGuard(){if(value)FreeSid(value);}} guard{raw};
        journal.profileSid=ascii(windows_runtime::sidText(raw));originalSession=encodeBrokerSession(session,cleanReleaseDigest);
        originalJournal=encodeBrokerJournal(journal,cleanReleaseDigest);save(journalPath,originalJournal,true);
    }
    ~Fixture(){SecureZeroMemory(bootstrap.launchToken.data(),bootstrap.launchToken.size());}
    void release(const std::function<void(size_t)>& boundary={},uint64_t deadline=0,
        const NativeCleanIntentRecordIo& intentIo=windowsCleanIntentRecordIo(),const NativeReleaseRecordIo& doneIo=windowsReleaseRecordIo()){
        releaseCleanBrokerSession(path,bootstrap,deadline?deadline:GetTickCount64()+5000,boundary,intentIo,doneIo,processes);processes.balanced();
    }
    void unchanged()const{
        check(read<1024>(root+L"\\"+sessionRecordLeaf)==originalSession,"source-session-changed");
        check(read<1024>(journalPath)==originalJournal,"source-journal-changed");
        requireBootstrapAbsent(root+L"\\"+sessionCleanReleaseLeaf);requireBootstrapAbsent(root+L"\\"+sessionCleanReleasedLeaf);
    }
    void updateJournal(){save(journalPath,encodeBrokerJournal(journal,cleanReleaseDigest));}
    void interrupt(size_t prefix){
        bool reached=false;fails([&]{release([&](size_t at){if(at==prefix){reached=true;throw WinError("test-interrupted",ERROR_OPERATION_ABORTED);}});},"test-interrupted");
        check(reached,"prefix-not-reached");processes.balanced();
    }
    void completed()const{
        requireBootstrapAbsent(reservation);check(read<1024>(root+L"\\"+sessionRecordLeaf)==originalSession,"original-session-not-retained");
        BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,false);lease.verify();lease.close();
        exactChildren(root,{sessionRecordLeaf,sessionLeaseLeaf,sessionCleanReleaseLeaf,sessionCleanReleasedLeaf});
        const auto intent=read<2048>(root+L"\\"+sessionCleanReleaseLeaf);const auto parsed=decodeBrokerCleanReleaseIntent(intent.data(),intent.size(),cleanReleaseDigest);
        const auto completion=read<1024>(root+L"\\"+sessionCleanReleasedLeaf);const auto done=decodeBrokerCleanReleaseCompletion(completion.data(),completion.size(),cleanReleaseDigest);
        check(encodeBrokerSession(parsed.session,cleanReleaseDigest)==originalSession,"intent-source-session");
        check(std::equal(originalJournal.begin(),originalJournal.end(),intent.begin()+brokerCleanJournalOffset),"intent-whole-journal");
        check(done.owner.intentDigest==cleanReleaseDigest(intent.data(),intent.size())&&done.journalDigest==parsed.journalDigest,"completion-digests");
        check(journalIdentityEqual(done.owner.intentFile,parsed.intentFile)&&journalIdentityEqual(done.journalFile,parsed.journalFile),"completion-identities");
    }
};
enum class IoFault{Write,ShortWrite,Flush,Read,ShortRead,Readback};
template<size_t Size> struct FaultIo final:FixedReleaseRecordIo<Size> {
    using Bytes=typename FixedReleaseRecordIo<Size>::Bytes;IoFault fault;mutable bool used=false;
    explicit FaultIo(IoFault value):fault(value){}
    bool take(IoFault value)const{if(!used&&fault==value){used=true;return true;}return false;}
    bool seek(HANDLE h)const override{return windowsFixedReleaseRecordIo<Size>().seek(h);}
    bool write(HANDLE h,const Bytes& bytes,DWORD& count)const override{
        if(take(IoFault::Write)){count=0;SetLastError(ERROR_WRITE_FAULT);return false;}
        if(take(IoFault::ShortWrite))return WriteFile(h,bytes.data(),16,&count,nullptr)!=FALSE;
        return windowsFixedReleaseRecordIo<Size>().write(h,bytes,count);
    }
    bool truncate(HANDLE h)const override{return windowsFixedReleaseRecordIo<Size>().truncate(h);}
    bool flush(HANDLE h)const override{if(take(IoFault::Flush)){SetLastError(ERROR_WRITE_FAULT);return false;}return windowsFixedReleaseRecordIo<Size>().flush(h);}
    bool read(HANDLE h,Bytes& bytes,DWORD& count)const override{
        if(take(IoFault::Read)){count=0;SetLastError(ERROR_READ_FAULT);return false;}
        const auto ok=windowsFixedReleaseRecordIo<Size>().read(h,bytes,count);
        if(ok&&take(IoFault::ShortRead)&&count)--count;
        if(ok&&take(IoFault::Readback))bytes[0]^=1;
        return ok;
    }
};
const char* ioError(IoFault fault){
    switch(fault){case IoFault::Write:return "mcp-release-write";case IoFault::ShortWrite:return "mcp-release-write-count";
        case IoFault::Flush:return "mcp-release-flush";case IoFault::Read:return "mcp-release-read";
        case IoFault::ShortRead:return "mcp-release-read-count";case IoFault::Readback:return "mcp-release-readback";}
    throw std::runtime_error("unknown-io-fault");
}
void replaceFile(const std::wstring& source,const std::wstring& backup,const JournalBytes& bytes){
    check(MoveFileExW(extended(source).c_str(),extended(backup).c_str(),0)!=FALSE,"test-move-original");save(source,bytes,true);
}
void run(const std::wstring& parent){
    scenario("normal-and-exact-completion-retry",[&]{Fixture f(parent);f.release();f.completed();const auto bytes=read<1024>(f.root+L"\\"+sessionCleanReleasedLeaf);f.release();f.completed();check(read<1024>(f.root+L"\\"+sessionCleanReleasedLeaf)==bytes,"completion-rewritten");f.processes.balanced();});
    for(size_t prefix=0;prefix<=2;++prefix)scenario("interrupted-prefix-retry",[&]{Fixture f(parent);f.interrupt(prefix);f.release();f.completed();});
    scenario("missing-journal-without-intent",[&]{Fixture f(parent);check(DeleteFileW(extended(f.journalPath).c_str())!=FALSE,"test-journal-delete");fails([&]{f.release();},"mcp-clean-release-initial-tree");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleaseLeaf);});
    scenario("missing-reservation-without-intent",[&]{Fixture f(parent);check(DeleteFileW(extended(f.journalPath).c_str())!=FALSE,"test-journal-delete");check(RemoveDirectoryW(extended(f.reservation).c_str())!=FALSE,"test-reservation-delete");fails([&]{f.release();},"mcp-clean-release-initial-tree");});
    scenario("present-worker-stage",[&]{Fixture f(parent);check(CreateDirectoryW(extended(f.reservation+L"\\worker").c_str(),nullptr)!=FALSE,"test-worker-create");fails([&]{f.release();},"bootstrap-still-present");f.unchanged();});
    scenario("unknown-reservation-child",[&]{Fixture f(parent);save(f.reservation+L"\\foreign.bin",JournalBytes{},true);fails([&]{f.release();},"mcp-tree-shape");f.unchanged();});
    for(unsigned which=0;which<3;++which)scenario("invalid-journal-context-before-intent",[&]{Fixture f(parent);if(which==0)f.journal.phase=BrokerPhase::Running;else if(which==1){f.journal.worker={};f.journal.profileSid.clear();}else f.journal.reservation.indexLow^=0x100;f.updateJournal();fails([&]{f.release();},"mcp-clean-release-context");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleaseLeaf);});
    scenario("wrong-generation-profile-sid",[&]{Fixture f(parent);f.journal.profileSid="S-1-15-2-101-102-103-104-105-106-107";f.updateJournal();fails([&]{f.release();},"mcp-clean-release-profile-identity");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleaseLeaf);});
    scenario("physical-reserved-session-bytes",[&]{Fixture f(parent);auto bytes=f.originalSession;bytes[700]=1;const auto digest=cleanReleaseDigest(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);save(f.root+L"\\"+sessionRecordLeaf,bytes);fails([&]{f.release();},"mcp-session-reserved");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleaseLeaf);});
    scenario("descriptor-ticket-mismatch",[&]{Fixture f(parent);f.bootstrap.launchToken[0]^=1;fails([&]{f.release();},"mcp-session-context");f.unchanged();});
    for(auto fault:{Processes::Fault::BrokerIdentity,Processes::Fault::WorkerIdentity,Processes::Fault::LiveBroker,Processes::Fault::LiveWorker,Processes::Fault::MissingSelf,Processes::Fault::RecordedPresent})scenario("uncertain-process-refuses-before-intent",[&]{Fixture f(parent);f.processes.fault=fault;const auto expected=fault==Processes::Fault::BrokerIdentity||fault==Processes::Fault::WorkerIdentity?"process-identity-mismatch":fault==Processes::Fault::LiveBroker||fault==Processes::Fault::LiveWorker?"process-exit-unproven":"process-snapshot-unproven";fails([&]{f.release();},expected);f.unchanged();f.processes.balanced();});
    scenario("complete-absent-snapshot-fallback",[&]{Fixture f(parent);f.processes.fault=Processes::Fault::SnapshotAbsent;f.release();f.completed();check(f.processes.snapshots>=2,"snapshot-not-used");f.processes.balanced();});
    scenario("empty-existing-job-at-prefix0-blocks-first-delete",[&]{Fixture f(parent);Handle job;bool created=false;
        fails([&]{f.release([&](size_t at){if(at==0){const auto name=L"Global\\Tahtiapuri.Mcp."+hex(f.bootstrap.generation.data(),f.bootstrap.generation.size());job.value=CreateJobObjectW(nullptr,name.c_str());const auto error=GetLastError();check(job.value&&error!=ERROR_ALREADY_EXISTS,"test-job-not-fresh");JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state={};check(QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&state,sizeof(state),nullptr)!=FALSE&&state.ActiveProcesses==0,"test-job-not-empty");created=true;}});},"mcp-clean-release-job-present");
        check(created,"test-job-boundary-not-reached");check(read<1024>(f.journalPath)==f.originalJournal,"job-race-deleted-journal");close(job);f.release();f.completed();});
    for(auto fault:{IoFault::Write,IoFault::ShortWrite,IoFault::Flush,IoFault::Read,IoFault::ShortRead,IoFault::Readback}){
        scenario("intent-io-error-and-allowed-retry",[&]{Fixture f(parent);FaultIo<2048> io(fault);fails([&]{f.release({},0,io);},ioError(fault));check(io.used,"intent-fault-unused");check(read<1024>(f.journalPath)==f.originalJournal,"intent-failure-deleted-journal");f.processes.balanced();if(fault==IoFault::Write||fault==IoFault::ShortWrite){fails([&]{f.release();},"mcp-release-record-length");}else{f.release();f.completed();}});
        scenario("completion-io-error-and-allowed-retry",[&]{Fixture f(parent);FaultIo<1024> io(fault);fails([&]{f.release({},0,windowsCleanIntentRecordIo(),io);},ioError(fault));check(io.used,"completion-fault-unused");requireBootstrapAbsent(f.reservation);f.processes.balanced();if(fault==IoFault::Write||fault==IoFault::ShortWrite){fails([&]{f.release();},"mcp-release-record-length");}else{f.release();f.completed();}});
    }
    scenario("delete-pending-reader-stops-before-parent",[&]{Fixture f(parent);BootstrapPin reader(f.journalPath,false,GENERIC_READ,OPEN_EXISTING,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);fails([&]{f.release();},"bootstrap-absence-uncertain");check(GetFileAttributesW(extended(f.reservation).c_str())!=INVALID_FILE_ATTRIBUTES,"parent-removed-before-definite-journal-absence");closeBootstrapHandle(reader);f.processes.balanced();f.release();f.completed();});
    scenario("replaced-journal-id-on-retry",[&]{Fixture f(parent);f.interrupt(0);replaceFile(f.journalPath,parent+L"\\saved-journal-"+std::to_wstring(fixtures),f.originalJournal);fails([&]{f.release();},"mcp-clean-release-journal-context");});
    scenario("replaced-session-id-on-retry",[&]{Fixture f(parent);f.interrupt(0);replaceFile(f.root+L"\\"+sessionRecordLeaf,parent+L"\\saved-session-"+std::to_wstring(fixtures),f.originalSession);fails([&]{f.release();},"mcp-clean-release-intent-context");});
    scenario("completion-must-match-exact-intent",[&]{Fixture f(parent);f.release();auto bytes=read<1024>(f.root+L"\\"+sessionCleanReleasedLeaf);auto record=decodeBrokerCleanReleaseCompletion(bytes.data(),bytes.size(),cleanReleaseDigest);record.journalDigest[0]^=1;save(f.root+L"\\"+sessionCleanReleasedLeaf,encodeBrokerCleanReleaseCompletion(record,cleanReleaseDigest));fails([&]{f.release();},"mcp-clean-release-completion-context");});
    for(const auto* leaf:{sessionReleaseLeaf,sessionReleasedLeaf})scenario("pristine-kind-fences-clean",[&]{Fixture f(parent);save(f.root+L"\\"+leaf,std::array<uint8_t,1>{0x7f},true);fails([&]{f.release();},"mcp-session-release-present");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleaseLeaf);});
    for(const auto* leaf:{sessionCleanReleaseLeaf,sessionCleanReleasedLeaf})for(unsigned operation=0;operation<5;++operation)scenario("malformed-clean-entry-fences-old-authority",[&]{Fixture f(parent);save(f.root+L"\\"+leaf,std::array<uint8_t,1>{0x7f},true);
        fails([&]{if(operation==0)prepareBrokerSession(f.path,f.bootstrap);else if(operation==1)sealBrokerSession(f.path,f.bootstrap);else if(operation==2){std::array<uint8_t,96> bytes={};constexpr uint8_t magic[8]={'T','M','B','O','O','T','1',0};std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,96);wirePut32(bytes.data()+16,f.bootstrap.main.pid);journalPut64(bytes.data()+24,f.bootstrap.main.creationTime);std::copy(f.bootstrap.pipeNonce.begin(),f.bootstrap.pipeNonce.end(),bytes.begin()+32);std::copy(f.bootstrap.generation.begin(),f.bootstrap.generation.end(),bytes.begin()+48);std::copy(f.bootstrap.launchToken.begin(),f.bootstrap.launchToken.end(),bytes.begin()+64);publishBrokerSession(f.path,bytes);}else if(operation==3){BootstrapDirectoryGuard control(f.path);BrokerSessionAdmission admission(control,f.bootstrap,GetTickCount64()+5000);}else releasePristineBrokerSession(f.path,f.bootstrap,GetTickCount64()+5000);},"mcp-session-release-present");});
    scenario("expired-deadline-cannot-start",[&]{Fixture f(parent);fails([&]{f.release({},GetTickCount64()-1);},"mcp-session-lease-timeout");f.unchanged();});
    scenario("deadline-after-intent-before-first-delete",[&]{Fixture f(parent);bool reached=false;fails([&]{f.release([&](size_t at){if(at==0){reached=true;Sleep(600);}},GetTickCount64()+500);},"mcp-session-lease-timeout");check(reached,"deadline-boundary-not-reached");check(read<1024>(f.journalPath)==f.originalJournal,"late-authority-deleted-journal");requireBootstrapAbsent(f.root+L"\\"+sessionCleanReleasedLeaf);f.processes.balanced();f.release();f.completed();});
    scenario("held-lease-times-out-without-intent-or-deletion",[&]{
        Fixture f(parent);BootstrapDirectoryGuard control(f.path);NativeSessionLease held(control,false);
        fails([&]{f.release({},GetTickCount64()+150);},"mcp-session-lease-timeout");
        f.unchanged();check(f.processes.opened==0,"process-proof-started-before-lease");
        held.close();f.release();f.completed();
    });
    scenario("delayed-lease-close-preserves-original-process-budget",[&]{
        Fixture f(parent);Handle ready(CreateEventW(nullptr,TRUE,FALSE,nullptr)),beginClose(CreateEventW(nullptr,TRUE,FALSE,nullptr));
        check(ready.value&&beginClose.value,"test-lease-events");
        std::exception_ptr failure;std::atomic<uint64_t> closeStarted{0};
        std::thread holder([&]{
            try{
                BootstrapDirectoryGuard control(f.path);NativeSessionLease held(control,false);
                check(SetEvent(ready.value)!=FALSE,"test-lease-ready");
                check(WaitForSingleObject(beginClose.value,3000)==WAIT_OBJECT_0,"test-lease-close-gate");
                Sleep(150);closeStarted.store(GetTickCount64());held.close();
            }catch(...){failure=std::current_exception();SetEvent(ready.value);}
        });
        struct Join{std::thread& thread;HANDLE gate;~Join(){SetEvent(gate);if(thread.joinable())thread.join();}} join{holder,beginClose.value};
        check(WaitForSingleObject(ready.value,1000)==WAIT_OBJECT_0,"test-lease-ready-timeout");
        // An actual share violation proves the fixture holds the common lease.
        bool contended=false;
        try{BootstrapDirectoryGuard control(f.path);NativeSessionLease probe(control,false);probe.close();}
        catch(const WinError& error){if(error.code!=ERROR_SHARING_VIOLATION)throw;contended=true;}
        check(contended,"test-lease-not-held");const auto deadline=GetTickCount64()+2000;
        check(SetEvent(beginClose.value)!=FALSE,"test-lease-close-start");f.release({},deadline);
        holder.join();if(failure)std::rethrow_exception(failure);
        check(closeStarted.load()!=0&&f.processes.firstWaitTick>=closeStarted.load(),"process-proof-before-lease-close");
        check(f.processes.firstWaitBudget>0&&f.processes.firstWaitBudget<2000,"lease-time-not-spent");
        check(f.processes.firstWaitTick+f.processes.firstWaitBudget==deadline,"process-budget-was-reset");
        f.completed();f.processes.balanced();
    });
    scenario("fixed-record-size-leaf-boundary",[&]{Fixture f(parent);BootstrapDirectoryGuard control(f.path);fails([&]{NativeCleanIntentRecord wrong(control,sessionReleaseLeaf,true,GetTickCount64()+5000);},"mcp-release-record-leaf");fails([&]{NativeReleaseRecord wrong(control,sessionCleanReleaseLeaf,true,GetTickCount64()+5000);},"mcp-release-record-leaf");f.unchanged();});
}
}
int wmain(int argc,wchar_t** argv){
    if(argc!=2)return 64;
    try{BootstrapDirectoryGuard parent(std::wstring(argv[1])+L"\\main-bootstrap.bin");run(parent.root);
        std::cout<<"{\"passed\":true,\"suite\":\"native-mcp-clean-release-owner-control\",\"cases\":"<<cases<<",\"fixtures\":"<<fixtures<<"}\n";return 0;
    }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
