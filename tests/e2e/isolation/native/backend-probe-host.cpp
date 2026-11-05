#include "backend-probe-resources.h"
#include "capability-diagnostic.h"
namespace bp=backend_probe;
using namespace isolation;
namespace {
void noConsole(DWORD pid) {
    DWORD list[2]={};
    if (GetConsoleProcessList(list,2)!=0) throw WinError("broker-console",ERROR_INVALID_DATA);
    const HANDLE input=GetStdHandle(STD_INPUT_HANDLE),output=GetStdHandle(STD_OUTPUT_HANDLE),error=GetStdHandle(STD_ERROR_HANDLE);
    if (AttachConsole(pid)) {
        FreeConsole(); SetStdHandle(STD_INPUT_HANDLE,input); SetStdHandle(STD_OUTPUT_HANDLE,output); SetStdHandle(STD_ERROR_HANDLE,error);
        throw WinError("unexpected-console",ERROR_INVALID_DATA);
    }
    if (GetLastError()!=ERROR_INVALID_HANDLE) throw WinError("console-observation");
}
std::string flag(bool value) { return value?"true":"false"; }
void detachBroker(Handle (&standard)[3]) {
    const DWORD names[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE}; DWORD console[2]={};
    for (auto name:names) if (GetFileType(GetStdHandle(name))!=FILE_TYPE_PIPE) throw WinError("broker-stdio");
    if (GetConsoleProcessList(console,2)==0) return;
    for (size_t i=0;i<3;++i) if (!DuplicateHandle(GetCurrentProcess(),GetStdHandle(names[i]),GetCurrentProcess(),
        &standard[i].value,0,FALSE,DUPLICATE_SAME_ACCESS)) throw WinError("broker-stdio");
    if (!FreeConsole()) throw WinError("broker-detach");
    for (size_t i=0;i<3;++i) if (!SetStdHandle(names[i],standard[i].value)) throw WinError("broker-restore");
}
}
int wmain(int argc,wchar_t** argv) {
    // All arguments select a fixed probe, never an arbitrary command or script.
    if (argc!=6 || std::wstring(argv[1])!=L"run") return 1;
    const std::wstring mode=argv[2],profile=argv[3]; bp::Nonce ownerNonce={};
    try {
        if ((mode!=L"control" && mode!=L"lpac") || !ownedProfile(profile,bp::profilePrefix)) return 1;
        ownerNonce=transport::parseSession(argv[5]);
    } catch (...) { return 1; }
    Handle standard[3],trustedInput,trustedOutput,job(CreateJobObjectW(nullptr,nullptr));
    if (!job.value) return 1;
    try {
        detachBroker(standard);
        if (!DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_INPUT_HANDLE),GetCurrentProcess(),&trustedInput.value,0,FALSE,DUPLICATE_SAME_ACCESS) ||
            !DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_OUTPUT_HANDLE),GetCurrentProcess(),&trustedOutput.value,0,FALSE,DUPLICATE_SAME_ACCESS))
            throw WinError("trusted-owner-pipes");
    } catch (...) { return 1; }
    bp::Failure state(job.value); bp::Queue inputQueue;
    std::unique_ptr<bp::Output> output; std::atomic<bp::Queue*> reportQueue{nullptr};
    std::unique_ptr<bp::IoTask> ownerReader,inputWriter,childReader,errorReader;
    std::unique_ptr<bp::Resources> resources;
    Handle child,parentWrite,parentRead,errorRead; PSID sid=nullptr;
    std::atomic<bool> prepared{false},startRequested{false},inputClosed{false},writerClosed{false},outputEof{false},stderrEof{false};
    std::atomic<bool> consoleAfter{false}; std::atomic<uint32_t> checkedSequence{0};
    std::atomic<size_t> ownerMessages{0},framesReceived{0},bytesReceived{0};
    bool created=false,childCreated=false,childResumed=false,consoleBefore=false,jobEmpty=false,restored=false,deleted=false;
    DWORD exitCode=STILL_ACTIVE; std::vector<BYTE> stderrBytes; size_t stderrObserved=0;
    Handle startEvent(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    // The supervisor runs independently of every potentially blocked pipe writer.
    std::thread supervisor([&] {
        const auto deadline=GetTickCount64()+20000; bool hardCancelled=false;
        while (!state.finished.load()) {
            const auto now=GetTickCount64();
            if (now>=deadline && !hardCancelled) {
                state.fail(2,"probe-deadline",ERROR_TIMEOUT); TerminateJobObject(job.value,42);
                inputQueue.abort(); if (auto queue=reportQueue.load()) queue->abort(); state.cancel(true); hardCancelled=true;
            }
            if (state.reason.load()) {
                TerminateJobObject(job.value,42); inputQueue.abort(); state.cancel(hardCancelled);
            }
            if (now>=deadline+2000) TerminateProcess(GetCurrentProcess(),72);
            Sleep(10);
        }
    });
    try {
        if (!startEvent.value) throw WinError("start-event");
        SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS); SetProcessAffinityMask(GetCurrentProcess(),1);
        DWORD_PTR affinity=0,system=0;
        if (!GetProcessAffinityMask(GetCurrentProcess(),&affinity,&system) || affinity!=1 ||
            GetPriorityClass(GetCurrentProcess())!=BELOW_NORMAL_PRIORITY_CLASS) throw WinError("broker-limits");
        output=std::make_unique<bp::Output>(ownerNonce,state,trustedOutput.value); reportQueue.store(&output->queue);
        ownerReader=std::make_unique<bp::IoTask>(state,[&] {
            uint32_t sequence=1; size_t payload=0;
            for (;;) {
                std::vector<BYTE> first(bp::headerBytes);
                if (!bp::readExact(trustedInput.value,first.data(),first.size(),true)) {
                    state.fail(1,"owner-eof",ERROR_BROKEN_PIPE); return;
                }
                const auto decoded=bp::decode(first,sequence++,ownerNonce,bp::requestBytes);
                if (decoded.kind==bp::Kill) {
                    if (decoded.length) throw WinError("kill-body",ERROR_INVALID_DATA);
                    state.fail(4,"owner-kill",ERROR_OPERATION_ABORTED); return;
                }
                if (decoded.kind==bp::Start) {
                    if (decoded.length || !prepared.load() || startRequested.exchange(true)) throw WinError("start-state",ERROR_INVALID_DATA);
                    SetEvent(startEvent.value); continue;
                }
                if (!startRequested.load() || inputClosed.load()) throw WinError("input-state",ERROR_INVALID_DATA);
                if (decoded.kind==bp::CloseInput) {
                    if (decoded.length) throw WinError("close-body",ERROR_INVALID_DATA);
                    inputClosed.store(true); inputQueue.push({bp::CloseInput,{},true},false,state); continue;
                }
                if (decoded.kind!=bp::App || !decoded.length || ++ownerMessages>256 ||
                    decoded.length>bp::ownerBudget-payload) throw WinError("owner-frame-budget",ERROR_INVALID_DATA);
                payload+=decoded.length; std::vector<BYTE> body(decoded.length);
                bp::readExact(trustedInput.value,body.data(),body.size());
                inputQueue.push({bp::App,std::move(body),false},false,state);
            }
        });
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|
            JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit=1; limits.BasicLimitInformation.Affinity=1;
        limits.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS; limits.JobMemoryLimit=512ULL*1024*1024;
        if (!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) throw WinError("job-limits");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual={};
        if (!QueryInformationJobObject(job.value,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr) ||
            actual.BasicLimitInformation.LimitFlags!=limits.BasicLimitInformation.LimitFlags || actual.BasicLimitInformation.ActiveProcessLimit!=1 ||
            actual.BasicLimitInformation.Affinity!=1 || actual.BasicLimitInformation.PriorityClass!=BELOW_NORMAL_PRIORITY_CLASS ||
            actual.JobMemoryLimit!=limits.JobMemoryLimit) throw WinError("job-readback",ERROR_INVALID_DATA);
        resources=std::make_unique<bp::Resources>(argv[4]); state.check();
        if (mode==L"lpac") {
            const auto result=CreateAppContainerProfile(profile.c_str(),L"Tahtiapuri backend probe",L"Synthetic backend only",nullptr,0,&sid);
            if (FAILED(result)) throw WinError("create-profile",static_cast<DWORD>(result));
            created=true; receipt(resources->root,profile,true);
        }
        resources->prepare(sid); state.check();
        Handle childRead,childWrite,errorWrite; SECURITY_ATTRIBUTES inherit={sizeof(inherit),nullptr,TRUE};
        auto pipe=[&](Handle& read,Handle& write,bool parentReads) {
            if (!CreatePipe(&read.value,&write.value,&inherit,4096) ||
                !SetHandleInformation(parentReads?read.value:write.value,HANDLE_FLAG_INHERIT,0)) throw WinError("pipes");
        };
        pipe(childRead,parentWrite,false); pipe(parentRead,childWrite,true); pipe(errorRead,errorWrite,true);
        Handle sentinel(CreateFileW((resources->root+L"\\private\\secret.txt").c_str(),GENERIC_READ,FILE_SHARE_READ,&inherit,OPEN_EXISTING,0,nullptr));
        if (sentinel.value==INVALID_HANDLE_VALUE) throw WinError("sentinel");
        RegistryReadCapability registry; SECURITY_CAPABILITIES caps={}; caps.AppContainerSid=sid;
        if (sid) { registry.derive(); caps.Capabilities=&registry.entry; caps.CapabilityCount=1; }
        DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT; Attributes attributes(sid?4:2);
        HANDLE handles[]={childRead.value,childWrite.value,errorWrite.value};
        attributes.put(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles)); attributes.put(PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.value,sizeof(job.value));
        if (sid) { attributes.put(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps));
            attributes.put(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy)); }
        STARTUPINFOEXW startup={}; startup.StartupInfo.cb=sizeof(startup); startup.lpAttributeList=attributes.list;
        startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput=childRead.value;
        startup.StartupInfo.hStdOutput=childWrite.value; startup.StartupInfo.hStdError=errorWrite.value;
        bp::Nonce childNonce={}; if (BCryptGenRandom(nullptr,childNonce.data(),32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0) throw WinError("child-nonce");
        if (childNonce==ownerNonce) throw WinError("nonce-collision",ERROR_INVALID_DATA);
        const auto image=resources->root+L"\\package\\node.exe";
        auto command=quote(image)+L" --preserve-symlinks --preserve-symlinks-main "+quote(resources->root+L"\\package\\backend-worker.mjs")+
            L" "+quote(resources->root)+L" "+quote(resources->dataRoot)+L" "+transport::sessionText(childNonce);
        auto environmentBlock=environment(resources->root); PROCESS_INFORMATION process={}; state.check();
        if (!CreateProcessW(image.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|
            CREATE_SUSPENDED|DETACHED_PROCESS,environmentBlock.data(),(resources->root+L"\\package").c_str(),&startup.StartupInfo,&process)) throw WinError("create-child");
        child.value=process.hProcess; childCreated=true; Handle initialThread(process.hThread);
        close(childRead); close(childWrite); close(errorWrite);
        const auto token=inspectToken(child.value); const auto capabilities=inspectCapabilities(child.value); requireCapabilities(capabilities,sid!=nullptr);
        BOOL member=FALSE;
        if (!IsProcessInJob(child.value,job.value,&member) || !member || activeCount(job.value)!=1 ||
            !GetProcessAffinityMask(child.value,&affinity,&system) || affinity!=1 || GetPriorityClass(child.value)!=BELOW_NORMAL_PRIORITY_CLASS ||
            sentinelInherited(child.value,sentinel.value)) throw WinError("process-readback",ERROR_ACCESS_DENIED);
        if (sid) {
            if (!token.app || token.integrity!=SECURITY_MANDATORY_LOW_RID || token.sid!=capabilitySidText(sid) ||
                (token.lpac>=0 && token.lpac!=1) || (token.lpac<0 && token.lpacQueryError!=ERROR_INVALID_PARAMETER))
                throw WinError("token-readback",ERROR_ACCESS_DENIED);
        } else if (token.app || token.capabilities || token.integrity!=SECURITY_MANDATORY_MEDIUM_RID) throw WinError("control-token",ERROR_ACCESS_DENIED);
        noConsole(process.dwProcessId); consoleBefore=true;
        prepared.store(true);
        output->json(bp::Prepared,"{\"pid\":"+std::to_string(process.dwProcessId)+",\"childNonce\":\""+ascii(transport::sessionText(childNonce))+
            "\",\"requestedPolicy\":\""+ascii(mode)+"\",\"creationMode\":\"detached-backend-probe\",\"appContainer\":"+flag(token.app)+
            ",\"lpac\":"+jsonFlag(token.lpac)+",\"lpacQueryError\":"+std::to_string(token.lpacQueryError)+",\"lpacQueryBytes\":"+std::to_string(token.lpacQueryBytes)+
            ",\"capabilitySids\":"+capabilityJson(capabilities)+",\"integrity\":"+std::to_string(token.integrity)+
            ",\"job\":true,\"activeProcessLimit\":1,\"affinity\":1,\"priority\":\"BelowNormal\",\"jobCommitBytes\":536870912,"+
            "\"sentinelInherited\":false,\"aclsVerified\":true,\"consoleAbsent\":true,\"networkVerified\":false}");
        while (WaitForSingleObject(startEvent.value,20)==WAIT_TIMEOUT) state.check(); state.check();
        if (ResumeThread(initialThread.value)==static_cast<DWORD>(-1)) throw WinError("resume"); childResumed=true;
        output->send(bp::Started); // Enqueue before the child-output reader exists.
        inputWriter=std::make_unique<bp::IoTask>(state,[&,childNonce] {
            uint32_t sequence=1; bp::Record record;
            while (inputQueue.take(record,state)) {
                if (record.barrier) { close(parentWrite); writerClosed.store(true); inputQueue.complete(record); return; }
                const auto first=bp::header(bp::App,sequence++,record.body.size(),childNonce);
                transport::writeAll(parentWrite.value,first.data(),first.size());
                transport::writeAll(parentWrite.value,record.body.data(),record.body.size()); inputQueue.complete(record);
            }
        });
        childReader=std::make_unique<bp::IoTask>(state,[&,childNonce,pid=process.dwProcessId] {
            uint32_t sequence=1; size_t payload=0;
            for (;;) {
                std::vector<BYTE> first(bp::headerBytes);
                if (!bp::readExact(parentRead.value,first.data(),first.size(),true)) { outputEof.store(true); return; }
                const auto decoded=bp::decode(first,sequence++,childNonce,bp::responseBytes);
                if (decoded.kind!=bp::App || !decoded.length || sequence>257 || decoded.length>bp::childBudget-payload)
                    throw WinError("child-frame-budget",ERROR_INVALID_DATA);
                payload+=decoded.length; size_t remaining=decoded.length; bool initial=true;
                do {
                    const size_t offset=initial?bp::headerBytes:0;
                    const size_t amount=std::min(remaining,bp::chunkBytes-offset);
                    std::vector<BYTE> chunk(offset+amount);
                    if (initial) std::copy(first.begin(),first.end(),chunk.begin());
                    bp::readExact(parentRead.value,chunk.data()+offset,amount); remaining-=amount;
                    if (!remaining && decoded.sequence==1) { noConsole(pid); checkedSequence.store(1); consoleAfter.store(true); }
                    output->send(bp::ChildChunk,std::move(chunk)); initial=false;
                } while (remaining);
                framesReceived.fetch_add(1); bytesReceived.fetch_add(decoded.length);
            }
        });
        errorReader=std::make_unique<bp::IoTask>(state,[&] {
            BYTE buffer[1024];
            for (;;) {
                DWORD got=0;
                if (!ReadFile(errorRead.value,buffer,sizeof(buffer),&got,nullptr)) {
                    if (GetLastError()!=ERROR_BROKEN_PIPE) throw WinError("stderr-read");
                    stderrEof.store(true); return;
                }
                if (!got) { stderrEof.store(true); return; }
                stderrObserved+=got;
                if (stderrObserved>16384) throw WinError("stderr-overflow",ERROR_BUFFER_OVERFLOW);
                stderrBytes.insert(stderrBytes.end(),buffer,buffer+got);
            }
        });
        while (WaitForSingleObject(child.value,20)==WAIT_TIMEOUT) state.check();
        if (!GetExitCodeProcess(child.value,&exitCode)) throw WinError("exit-code");
        if (exitCode!=0 || !inputClosed.load()) {
            state.fail(3,"unexpected-worker-exit",ERROR_PROCESS_ABORTED);
            inputQueue.abort(); state.cancel(false);
        }
        childReader->join(); errorReader->join(); inputWriter->join(); state.check();
        if (exitCode || !inputClosed.load() || !writerClosed.load() || !outputEof.load() || !stderrEof.load() ||
            !consoleAfter.load() || framesReceived.load()==0) throw WinError("incomplete-normal-exit",ERROR_INVALID_DATA);
    } catch (const WinError& error) { state.fail(3,error.what(),error.code); }
      catch (...) { state.fail(3,"probe-exception"); }
    jobEmpty=stopJob(job.value);
    if (child.value) GetExitCodeProcess(child.value,&exitCode);
    if (state.reason.load()) { inputQueue.abort(); state.cancel(false); }
    if (inputWriter) inputWriter->join(); if (childReader) childReader->join(); if (errorReader) errorReader->join();
    if (jobEmpty && resources) {
        try { resources->restorePersistent(); restored=true; }
        catch (const WinError& error) { state.fail(3,error.what(),error.code); }
        catch (...) { state.fail(3,"persistent-acl-restore"); }
    }
    deleted=!created;
    if (created && jobEmpty && restored) {
        const auto result=DeleteAppContainerProfile(profile.c_str()); deleted=SUCCEEDED(result);
        if (!deleted) state.fail(3,"profile-delete",static_cast<DWORD>(result));
    }
    if (sid) FreeSid(sid);
    bool passed=state.reason.load()==0 && jobEmpty && restored && deleted && exitCode==0 && childResumed &&
        inputClosed.load() && writerClosed.load() && outputEof.load() && stderrEof.load() && consoleBefore && consoleAfter.load();
    if (!jobEmpty) state.fail(3,"job-cleanup");
    try {
        if (output) {
            output->send(bp::Stderr,std::move(stderrBytes));
            std::string failure; DWORD error=0;
            { std::lock_guard<std::mutex> lock(state.mutex); failure=state.stage; error=state.error; }
            output->json(bp::Result,"{\"stderrComplete\":"+flag(stderrEof.load())+",\"stderrBytes\":"+std::to_string(stderrObserved)+",\"passed\":"+flag(passed)+",\"childCreated\":"+flag(childCreated)+",\"childResumed\":"+flag(childResumed)+
                ",\"exitCode\":"+std::to_string(exitCode)+",\"watchdog\":"+std::to_string(state.reason.load())+",\"jobEmpty\":"+flag(jobEmpty)+
                ",\"persistentAclRestored\":"+flag(restored)+",\"profileDeleted\":"+flag(deleted)+",\"consoleBefore\":"+flag(consoleBefore)+
                ",\"consoleAfterFirstFrame\":"+flag(consoleAfter.load())+",\"consoleCheckedSequence\":"+std::to_string(checkedSequence.load())+
                ",\"framesReceived\":"+std::to_string(framesReceived.load())+",\"bytesReceived\":"+std::to_string(bytesReceived.load())+
                ",\"ownerMessages\":"+std::to_string(ownerMessages.load())+",\"failure\":\""+failure+"\",\"error\":"+std::to_string(error)+"}");
            output->finish();
        } else passed=false;
    } catch (...) { passed=false; }
    if (ownerReader) { ownerReader->stop(); ownerReader->join(); }
    passed=passed && state.reason.load()==0;
    state.finished.store(true); supervisor.join();
    return passed?0:1;
}
