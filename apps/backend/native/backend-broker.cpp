#include "backend-recovery.h"
#include "backend-observing-migration.h"
#include <cstddef>
#pragma comment(lib,"OneCoreUAP.lib")

namespace br=backend_runtime;
namespace {
using namespace br;
constexpr wchar_t registrySid[]=L"S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";
std::string flag(bool value){return value?"true":"false";}
struct MigrationGuardLifetime {
    std::unique_ptr<WindowsObservingMigrationIo> io;bool cleanupVerified=false;
    ~MigrationGuardLifetime(){if(!cleanupVerified)(void)io.release();}
};
struct Attributes {
    std::vector<BYTE> storage;LPPROC_THREAD_ATTRIBUTE_LIST value=nullptr;
    explicit Attributes(DWORD count){SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,count,0,&bytes);if(!bytes)throw WinError("attribute-size");storage.resize(bytes);value=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());if(!InitializeProcThreadAttributeList(value,count,0,&bytes)){value=nullptr;throw WinError("attribute-init");}}
    void put(DWORD_PTR key,void* data,SIZE_T bytes){if(!UpdateProcThreadAttribute(value,0,key,data,bytes,nullptr,nullptr))throw WinError("attribute-set");}
    ~Attributes(){if(value)DeleteProcThreadAttributeList(value);}
};
struct RegistryCapability {
    PSID* groups=nullptr;DWORD groupCount=0;PSID* sids=nullptr;DWORD sidCount=0;SID_AND_ATTRIBUTES entry={};
    RegistryCapability(){if(!DeriveCapabilitySidsFromName(L"registryRead",&groups,&groupCount,&sids,&sidCount))throw WinError("capability-derive");if(sidCount!=1||!sids||sidText(sids[0])!=registrySid)throw WinError("capability-derived-policy",ERROR_INVALID_SID);entry={sids[0],SE_GROUP_ENABLED};}
    ~RegistryCapability(){if(groups){for(DWORD i=0;i<groupCount;++i)LocalFree(groups[i]);LocalFree(groups);}if(sids){for(DWORD i=0;i<sidCount;++i)LocalFree(sids[i]);LocalFree(sids);}}
};
void verifyCapability(HANDLE process){
    Handle token;if(!OpenProcessToken(process,TOKEN_QUERY,&token.value))throw WinError("capability-token");auto bytes=tokenInfo(token.value,TokenCapabilities);
    if(bytes.size()<offsetof(TOKEN_GROUPS,Groups)+sizeof(SID_AND_ATTRIBUTES))throw WinError("capability-buffer",ERROR_INVALID_DATA);
    auto groups=reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());if(groups->GroupCount!=1||groups->Groups[0].Attributes!=SE_GROUP_ENABLED)throw WinError("capability-policy",ERROR_ACCESS_DENIED);
    PSID sid=groups->Groups[0].Sid;const auto base=reinterpret_cast<ULONG_PTR>(bytes.data()),address=reinterpret_cast<ULONG_PTR>(sid);
    if(address<base||address-base>bytes.size()-8)throw WinError("capability-pointer",ERROR_INVALID_DATA);
    const auto raw=static_cast<SID*>(sid);if(raw->SubAuthorityCount>SID_MAX_SUB_AUTHORITIES||8+size_t(raw->SubAuthorityCount)*4>bytes.size()-(address-base)||sidText(sid)!=registrySid)throw WinError("capability-sid-policy",ERROR_INVALID_SID);
}

struct OwnerPipes {
    Handle handles[3];
    OwnerPipes(){const DWORD names[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
        for(size_t i=0;i<3;++i){auto pipe=GetStdHandle(names[i]);if(GetFileType(pipe)!=FILE_TYPE_PIPE||!DuplicateHandle(GetCurrentProcess(),pipe,GetCurrentProcess(),&handles[i].value,0,FALSE,DUPLICATE_SAME_ACCESS))throw WinError("owner-pipes");}
        DWORD list[2]={};if(GetConsoleProcessList(list,2)&&!FreeConsole())throw WinError("broker-detach");restore();}
    void restore() const {const DWORD names[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};for(size_t i=0;i<3;++i)if(!SetStdHandle(names[i],handles[i].value))throw WinError("owner-pipe-restore");}
    void noConsole(DWORD pid) const {DWORD list[2]={};if(GetConsoleProcessList(list,2))throw WinError("broker-console",ERROR_INVALID_DATA);
        if(AttachConsole(pid)){FreeConsole();restore();throw WinError("worker-console",ERROR_INVALID_DATA);}DWORD error=GetLastError();restore();if(error!=ERROR_INVALID_HANDLE)throw WinError("console-observation",error);}
};
std::vector<wchar_t> environment(const Resources& resources){
    std::array<wchar_t,32768> windows={};UINT count=GetWindowsDirectoryW(windows.data(),static_cast<UINT>(windows.size()));if(!count||count>=windows.size())throw WinError("windows-directory");const auto root=canonicalPath(windows.data());
    std::vector<wchar_t> block;for(const auto& item:{L"APPDATA="+resources.scratchRoot,L"LOCALAPPDATA="+resources.scratchRoot,L"PATH="+root+L"\\System32",L"SystemRoot="+root,L"TEMP="+resources.scratchRoot,L"TMP="+resources.scratchRoot,L"USERPROFILE="+resources.scratchRoot,L"WINDIR="+root}){block.insert(block.end(),item.begin(),item.end());block.push_back(0);}block.push_back(0);return block;
}
void createPipe(Handle& read,Handle& write,bool parentReads){SECURITY_ATTRIBUTES attrs={sizeof(attrs),nullptr,TRUE};if(!CreatePipe(&read.value,&write.value,&attrs,4096)||!SetHandleInformation(parentReads?read.value:write.value,HANDLE_FLAG_INHERIT,0))throw WinError("child-pipe");}

// The watchdog never waits for an owner or worker pipe. A hard deadline exits
// without a success receipt, leaving the durable journal for the next recovery.
class Supervisor {
    Failure& failure;Queue& input;std::thread thread;std::atomic<bool> done{false};
public:
    std::atomic<HANDLE> job{nullptr};std::atomic<Output*> output{nullptr};
    std::atomic<uint64_t> deadline{0},lease{0},readyDeadline{0},closeDeadline{0};FrameClock ownerClock,childClock;
    Supervisor(Failure& state,Queue& queue):failure(state),input(queue){thread=std::thread([this]{uint64_t failedAt=0;while(!done.load()){
        const auto t=now(),phaseEnd=deadline.load(),leased=lease.load(),readyEnd=readyDeadline.load(),closeEnd=closeDeadline.load();auto fail=[&](const char* reason){failure.fail(reason,ERROR_TIMEOUT);};
        if(phaseEnd&&t>=phaseEnd){fail("phase-timeout");TerminateProcess(GetCurrentProcess(),74);}
        if(ownerClock.expired(t)||childClock.expired(t))fail("frame-timeout");
        if(leased&&t>=leased&&t-leased>=10000)fail("owner-lease");
        if(readyEnd&&t>=readyEnd)fail("ready-timeout");
        if(closeEnd&&t>=closeEnd)fail("shutdown-timeout");
        if(auto reports=output.load()){auto since=reports->writingSince.load();if(since&&t>=since&&t-since>=2000){fail("output-backpressure");reports->queue.abort();}}
        if(failure.failed.load()){if(!failedAt)failedAt=t;input.abort();if(auto handle=job.load())TerminateJobObject(handle,42);
            // Main must enter its independently bounded cleanup promptly.
            if(!deadline.load()&&t-failedAt>=7000)TerminateProcess(GetCurrentProcess(),74);}
        Sleep(10);
    }});}
    void stop(){done.store(true);if(thread.joinable())thread.join();}
    ~Supervisor(){stop();}
};
struct Receipt {
    bool childCreated=false,childResumed=false,jobEmpty=false,restored=false,profileDeleted=false,sessionRemoved=false,journalClean=false,stderrComplete=false,consoleBefore=false,consoleAfter=false;
    DWORD exitCode=STILL_ACTIVE;std::wstring run;
    std::string json(const char* outcome,const char* cleanup,const char* reason,DWORD error) const {
        return "{\"sessionOutcome\":\""+std::string(outcome)+"\",\"cleanupOutcome\":\""+cleanup+"\",\"reason\":\""+reason+"\",\"error\":"+std::to_string(error)+",\"runNonce\":"+(run.empty()?"null":"\""+narrow(run)+"\"")+",\"childCreated\":"+flag(childCreated)+",\"childResumed\":"+flag(childResumed)+",\"exitCode\":"+(exitCode==STILL_ACTIVE?"null":std::to_string(exitCode))+",\"jobEmpty\":"+flag(jobEmpty)+",\"persistentAclRestored\":"+flag(restored)+",\"profileDeleted\":"+flag(profileDeleted)+",\"sessionRemoved\":"+flag(sessionRemoved)+",\"journalClean\":"+flag(journalClean)+",\"stderrComplete\":"+flag(stderrComplete)+",\"consoleBefore\":"+flag(consoleBefore)+",\"consoleAfterFirstFrame\":"+flag(consoleAfter)+"}";
    }
};
const char* reasonFor(const Failure& failure){
    if(!failure.failed.load())return "none";const auto& stage=failure.stage;
    if(stage=="owner-eof")return "owner-eof";if(stage=="owner-kill")return "owner-kill";if(stage=="owner-lease")return "owner-lease";
    if(stage.find("timeout")!=std::string::npos)return "timeout";if(stage.find("backpressure")!=std::string::npos)return "backpressure";
    if(stage=="worker-exit"||stage=="normal-exit-incomplete")return "worker-exit";
    if(stage.find("frame")!=std::string::npos||stage.find("owner-")==0||stage.find("input-")==0||stage.find("sequence")!=std::string::npos)return "protocol";
    return stage=="internal-exception"?"internal":"isolation";
}
}
int wmain(int argc,wchar_t** argv){
    using namespace br;
    bool recover=false;std::wstring stateRoot,run;Nonce ownerNonce={};
    try{
        if(argc==4&&std::wstring(argv[1])==L"recover"){recover=true;stateRoot=canonicalPath(argv[2]);ownerNonce=parseNonce(argv[3]);}
        else if(argc==5&&std::wstring(argv[1])==L"run"){stateRoot=canonicalPath(argv[2]);run=argv[3];if(!lowerHex(run,32))return 64;ownerNonce=parseNonce(argv[4]);}
        else return 64;
    }catch(...){return 64;}
    try{
        OwnerPipes pipes;Failure failure;Queue input;
        std::unique_ptr<Ownership> ownership;std::unique_ptr<Journal> journal;std::unique_ptr<Resources> resources;
        MigrationGuardLifetime migrationGuard;auto& migrationIo=migrationGuard.io;std::unique_ptr<ObservingMigration> migration;
        std::unique_ptr<NamedJob> job;std::unique_ptr<ProfileSid> profile;std::unique_ptr<Output> output;
        Supervisor watch(failure,input);watch.deadline.store(now()+30000);
        Handle child,parentWrite,parentRead,errorRead,initialThread;
        std::atomic<bool> prepared{false},startRequested{false},started{false},inputClosed{false},writerClosed{false},outputEof{false},stderrEof{false},firstFrame{false};
        std::atomic<bool> migrationWaiting{false},migrationDecisionReady{false};std::mutex migrationMutex;std::vector<BYTE> migrationDecision;bool migrationReady=false;
        std::vector<BYTE> stderrBody;Receipt receipt;receipt.run=run;bool cleanupFailed=false,normal=false,began=false;
        // Tasks are destroyed before every local captured by their actions.
        std::unique_ptr<IoTask> ownerReader,inputWriter,childReader,errorReader;
        try{
            output=std::make_unique<Output>(ownerNonce,pipes.handles[1].value,failure);watch.output.store(output.get());
            if(!recover)ownerReader=std::make_unique<IoTask>(failure,[&]{
                Sequence sequence;for(;;){std::array<BYTE,headerBytes> first={};
                    if(!readExact(pipes.handles[0].value,first.data(),first.size(),watch.ownerClock,true)){failure.fail("owner-eof",ERROR_BROKEN_PIPE);return;}
                    auto decoded=decode(first,sequence.take(),ownerNonce,ownerAppBytes);
                    if(decoded.kind==Kill){if(decoded.size)throw WinError("owner-kill-body",ERROR_INVALID_DATA);watch.ownerClock.finish();watch.lease.store(now());failure.fail("owner-kill",ERROR_OPERATION_ABORTED);return;}
                    if(decoded.kind==MigrationDecision){
                        if(decoded.size!=68||!migrationWaiting.exchange(false)||migrationDecisionReady.load())throw WinError("migration-owner-decision-state",ERROR_INVALID_DATA);
                        std::vector<BYTE> body(68);readExact(pipes.handles[0].value,body.data(),body.size(),watch.ownerClock);watch.ownerClock.finish();
                        {std::lock_guard<std::mutex> lock(migrationMutex);migrationDecision=std::move(body);}migrationDecisionReady.store(true);continue;
                    }
                    if(decoded.kind==Start){if(decoded.size||!prepared.load()||startRequested.load())throw WinError("owner-start-state",ERROR_INVALID_DATA);watch.ownerClock.finish();watch.lease.store(now());watch.readyDeadline.store(now()+10000);startRequested.store(true);continue;}
                    if(decoded.kind==Heartbeat){if(decoded.size||!started.load())throw WinError("owner-heartbeat-state",ERROR_INVALID_DATA);watch.ownerClock.finish();watch.lease.store(now());continue;}
                    if(!started.load()||inputClosed.load())throw WinError("owner-input-state",ERROR_INVALID_DATA);
                    if(decoded.kind==CloseInput){if(decoded.size)throw WinError("owner-close-body",ERROR_INVALID_DATA);inputClosed.store(true);watch.closeDeadline.store(now()+2000);watch.ownerClock.finish();watch.lease.store(now());input.push({CloseInput,{},true},false,failure);continue;}
                    if(decoded.kind!=App||!decoded.size)throw WinError("owner-frame-kind",ERROR_INVALID_DATA);
                    std::vector<BYTE> body(decoded.size);readExact(pipes.handles[0].value,body.data(),body.size(),watch.ownerClock);watch.ownerClock.finish();
                    watch.lease.store(now());input.push({App,std::move(body),false},false,failure);
                }
            });
            ownership=std::make_unique<Ownership>(stateRoot);failure.check();journal=std::make_unique<Journal>(*ownership);
            if(recover)receipt.run=journal->current().run;
            // Recovery itself authenticates the journal and exact Job identity.
            Recovery(*ownership,*journal).run([&](RecoveryStage,uint64_t deadline){watch.deadline.store(deadline);});failure.check();
            if(recover){receipt.jobEmpty=true;receipt.restored=true;receipt.profileDeleted=true;receipt.sessionRemoved=true;receipt.journalClean=true;normal=true;}
            else{
                // One existing preparation budget includes guarded snapshots,
                // Main's decision, publication, and all worker preparation.
                watch.deadline.store(now()+30000);migrationIo=std::make_unique<WindowsObservingMigrationIo>(*ownership);
                migration=std::make_unique<ObservingMigration>(MigrationContext{narrow(ownership->owner.text),idText(ownership->state->id),idText(ownership->data->id)},*migrationIo,[&]{failure.check();});
                output->send(MigrationSourceFrame,migration->sourceFrame());auto destination=migration->destinationFrame();migrationWaiting.store(true);output->send(MigrationDestinationFrame,std::move(destination));
                while(!migrationDecisionReady.load()){failure.check();Sleep(10);}failure.check();
                std::vector<BYTE> decision;{std::lock_guard<std::mutex> lock(migrationMutex);decision=std::move(migrationDecision);}
                auto migrated=migration->decide(decision);failure.check();output->send(Migrated,std::move(migrated));migrationReady=true;migrationIo->verifyGuard();
                resources=std::make_unique<Resources>(*ownership,run);failure.check();journal->begin(run);began=true;
                job=std::make_unique<NamedJob>(ownership->owner,run);watch.job.store(job->handle.value);profile=journal->createProfile();failure.check();
                journal->prepareResources(*resources);failure.check();
                Handle childRead,childWrite,errorWrite;createPipe(childRead,parentWrite,false);createPipe(parentRead,childWrite,true);createPipe(errorRead,errorWrite,true);
                RegistryCapability registry;SECURITY_CAPABILITIES caps={};caps.AppContainerSid=profile->value;caps.Capabilities=&registry.entry;caps.CapabilityCount=1;
                DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;Attributes attributes(4);HANDLE inherited[]={childRead.value,childWrite.value,errorWrite.value};
                attributes.put(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited));attributes.put(PROC_THREAD_ATTRIBUTE_JOB_LIST,&job->handle.value,sizeof(job->handle.value));
                attributes.put(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps));attributes.put(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy));
                STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes.value;startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput=childRead.value;startup.StartupInfo.hStdOutput=childWrite.value;startup.StartupInfo.hStdError=errorWrite.value;
                Nonce childNonce={};if(BCryptGenRandom(nullptr,childNonce.data(),static_cast<ULONG>(childNonce.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)throw WinError("child-nonce");
                if(childNonce==ownerNonce)throw WinError("nonce-collision",ERROR_INVALID_DATA);
                canonicalPath(resources->nodePath);canonicalPath(resources->entryPath);canonicalPath(ownership->dataRoot);
                auto command=quote(resources->nodePath)+L" --preserve-symlinks --preserve-symlinks-main "+quote(resources->entryPath)+L" "+quote(ownership->dataRoot)+L" "+nonceText(childNonce);
                auto env=environment(*resources);PROCESS_INFORMATION process={};failure.check();
                createRecordedProcess(*journal,[&]{
                    if(!CreateProcessW(resources->nodePath.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|DETACHED_PROCESS,
                        env.data(),resources->packageRoot.c_str(),&startup.StartupInfo,&process))throw WinError("child-create");
                    child.value=process.hProcess;initialThread.value=process.hThread;receipt.childCreated=true;
                },[&]{return std::make_pair(process.dwProcessId,windowsProcessWitnessApi().creationTime(child.value));});
                closeHandle(childRead);closeHandle(childWrite);closeHandle(errorWrite);
                verifyJobSecurity(job->handle.value,ownership->owner);verifyJobLimits(job->handle.value);BOOL member=FALSE;DWORD_PTR affinity=0,system=0;
                if(!IsProcessInJob(child.value,job->handle.value,&member)||!member||job->active()!=1||!GetProcessAffinityMask(child.value,&affinity,&system)||affinity!=1||GetPriorityClass(child.value)!=BELOW_NORMAL_PRIORITY_CLASS)throw WinError("child-job-readback",ERROR_ACCESS_DENIED);
                const auto token=inspectToken(child.value);verifyCapability(child.value);
                if(!token.app||token.integrity!=SECURITY_MANDATORY_LOW_RID||token.sid!=sidText(profile->value)||token.capabilities!=1||
                    (token.lpac!=1&&!(token.lpac==-1&&token.lpacQueryError==ERROR_INVALID_PARAMETER&&token.lpacQueryBytes==0)))throw WinError("child-token-readback",ERROR_ACCESS_DENIED);
                pipes.noConsole(process.dwProcessId);receipt.consoleBefore=true;failure.check();
                journal->requireRecorded();prepared.store(true);watch.lease.store(now());watch.deadline.store(0);
                output->json(Prepared,"{\"pid\":"+std::to_string(process.dwProcessId)+",\"childNonce\":\""+narrow(nonceText(childNonce))+"\",\"requestedPolicy\":\"lpac-registryRead\",\"creationMode\":\"detached-backend\",\"appContainer\":true,\"lpac\":"+jsonFlag(token.lpac)+",\"lpacQueryError\":"+std::to_string(token.lpacQueryError)+",\"lpacQueryBytes\":"+std::to_string(token.lpacQueryBytes)+",\"capabilitySids\":[{\"sid\":\""+narrow(registrySid)+"\",\"attributes\":4}],\"integrity\":4096,\"job\":true,\"activeProcessLimit\":1,\"affinity\":1,\"priority\":\"BelowNormal\",\"processMemoryBytes\":536870912,\"aclsVerified\":true,\"consoleAbsent\":true,\"networkVerified\":false}");
                while(!startRequested.load()){failure.check();Sleep(10);}failure.check();
                resumeRecordedProcess(*journal,[&]{if(ResumeThread(initialThread.value)==static_cast<DWORD>(-1))throw WinError("child-resume");receipt.childResumed=true;});
                started.store(true);output->send(Started);journal->advance(Phase::Running);failure.check();
                inputWriter=std::make_unique<IoTask>(failure,[&,childNonce]{Sequence sequence;Record record;while(input.take(record)){
                    if(record.barrier){closeHandle(parentWrite);writerClosed.store(true);input.complete(record);return;}
                    auto first=header(App,sequence.take(),record.body.size(),childNonce);writeAll(parentWrite.value,first.data(),first.size());writeAll(parentWrite.value,record.body.data(),record.body.size());input.complete(record);
                }});
                childReader=std::make_unique<IoTask>(failure,[&,childNonce,pid=process.dwProcessId]{Sequence sequence;for(;;){std::array<BYTE,headerBytes> first={};
                    if(!readExact(parentRead.value,first.data(),first.size(),watch.childClock,true)){outputEof.store(true);return;}
                    auto decoded=decode(first,sequence.take(),childNonce,childAppBytes);if(decoded.kind!=App||!decoded.size)throw WinError("child-frame-kind",ERROR_INVALID_DATA);
                    size_t remaining=decoded.size;bool initial=true;
                    do{const size_t offset=initial?headerBytes:0,amount=std::min(remaining,chunkBytes-offset);std::vector<BYTE> chunk(offset+amount);
                        if(initial)std::copy(first.begin(),first.end(),chunk.begin());readExact(parentRead.value,chunk.data()+offset,amount,watch.childClock);remaining-=amount;
                        if(!remaining&&decoded.sequence==1){pipes.noConsole(pid);firstFrame.store(true);watch.readyDeadline.store(0);}output->send(ChildChunk,std::move(chunk));initial=false;
                    }while(remaining);watch.childClock.finish();
                }});
                errorReader=std::make_unique<IoTask>(failure,[&]{std::array<BYTE,1024> buffer={};for(;;){DWORD got=0;if(!ReadFile(errorRead.value,buffer.data(),static_cast<DWORD>(buffer.size()),&got,nullptr)){
                        if(GetLastError()!=ERROR_BROKEN_PIPE)throw WinError("stderr-read");stderrEof.store(true);return;}
                    if(!got){stderrEof.store(true);return;}const size_t keep=std::min<size_t>(got,16384-stderrBody.size());stderrBody.insert(stderrBody.end(),buffer.begin(),buffer.begin()+keep);
                }});
                bool closingJournal=false;
                while(WaitForSingleObject(child.value,10)==WAIT_TIMEOUT){failure.check();if(inputClosed.load()&&!closingJournal){journal->advance(Phase::Closing);closingJournal=true;}}
                if(!GetExitCodeProcess(child.value,&receipt.exitCode))throw WinError("child-exit-code");
                if(receipt.exitCode||!inputClosed.load())throw WinError("worker-exit",ERROR_PROCESS_ABORTED);
                // The grace budget also covers pipe drains and the ordered close barrier.
                while(!childReader->complete()||!errorReader->complete()||!inputWriter->complete()){failure.check();Sleep(10);}
                childReader->join();errorReader->join();inputWriter->join();failure.check();
                if(!writerClosed.load()||!outputEof.load()||!stderrEof.load()||!firstFrame.load())throw WinError("normal-exit-incomplete",ERROR_INVALID_DATA);
                normal=true;
            }
        }catch(const WinError& error){failure.fail(error.what(),error.code);}catch(...){failure.fail("internal-exception",ERROR_UNHANDLED_EXCEPTION);}

        // Stop owner admission and every worker I/O task before restoring resources.
        // No report write is required for this sequence to progress.
        watch.deadline.store(now()+20000);watch.lease.store(0);watch.readyDeadline.store(0);watch.closeDeadline.store(0);input.abort();
        if(ownerReader){ownerReader->cancel();ownerReader->join();}if(inputWriter){inputWriter->cancel();inputWriter->join();}
        if(childReader){childReader->cancel();childReader->join();}if(errorReader){errorReader->cancel();errorReader->join();}
        watch.ownerClock.finish();watch.childClock.finish();receipt.stderrComplete=stderrEof.load();receipt.consoleAfter=firstFrame.load();
        ownerReader.reset();inputWriter.reset();childReader.reset();errorReader.reset();closeHandle(parentWrite);closeHandle(parentRead);closeHandle(errorRead);closeHandle(initialThread);
        if(!recover&&began&&journal&&ownership){
            try{
                WindowsRecoveryApi cleanup(*ownership,resources.get(),job.get());
                cleanupCurrent(*journal,cleanup,[&](RecoveryStage,uint64_t deadline){watch.deadline.store(deadline);},[&](CleanupStep step){
                    if(step==CleanupStep::JobEmpty){receipt.jobEmpty=true;if(child.value&&!GetExitCodeProcess(child.value,&receipt.exitCode))throw WinError("child-final-exit");}
                    else if(step==CleanupStep::Restored)receipt.restored=true;else if(step==CleanupStep::ProfileDeleted)receipt.profileDeleted=true;
                    else if(step==CleanupStep::SessionRemoved)receipt.sessionRemoved=true;else if(step==CleanupStep::Clean)receipt.journalClean=true;
                });
            }catch(const WinError& error){cleanupFailed=true;failure.fail("cleanup",error.code);}catch(...){cleanupFailed=true;failure.fail("cleanup",ERROR_UNHANDLED_EXCEPTION);}
        }
        if(!receipt.journalClean)cleanupFailed=true;
        if(migrationReady){try{migrationIo->verifyGuard();}catch(const WinError& error){cleanupFailed=true;failure.fail(error.what(),error.code);}catch(...){cleanupFailed=true;failure.fail("migration-guard",ERROR_UNHANDLED_EXCEPTION);}}
        watch.job.store(nullptr);closeHandle(child);
        const char* outcome=recover?(normal?"recovered":"failed"):(normal&&!failure.failed.load()?"normal":"failed");
        bool reported=false;watch.deadline.store(now()+2000);
        try{if(output){if(!stderrBody.empty())output->send(Stderr,std::move(stderrBody),true);
            output->json(Result,receipt.json(outcome,cleanupFailed?"blocked":"clean",cleanupFailed?"cleanup":reasonFor(failure),failure.failed.load()?failure.error:0),true);output->finish();reported=output->delivered.load();}}
        catch(...){reported=false;}
        // Keep the report deadline alive while cancelling a deaf owner's writer.
        // Output's later destructor then has no live synchronous I/O to join.
        if(output){output->abort();output->finish();}
        watch.stop();watch.output.store(nullptr);output.reset();
        // Cleanup-unverified includes pre-begin migration/staging failures.
        // Keep its guard handles until OS process termination, not an earlier
        // scope destructor. No destructor repairs or deletes migration files.
        migrationGuard.cleanupVerified=!cleanupFailed;
        return reported&&!cleanupFailed&&normal&&!failure.failed.load()?0:1;
    }catch(...){return 1;}
}
