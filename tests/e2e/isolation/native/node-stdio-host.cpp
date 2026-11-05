// Fixed synthetic Node launcher. No change to the native model launch policy.
#include "../../../../packages/windows-runtime/native/isolated-launcher.h"
#include "../../../../packages/windows-runtime/native/owner-input.h"
#include "capability-diagnostic.h"
#include "node-stdio-pins.h"
using namespace isolation;
namespace {
constexpr char marker[]="TAHTIAPURI_NODE_STDIO_ONLY";
constexpr wchar_t prefix[]=L"tahtiapuri.stdio.";
#if defined(NODE_STDIO_DETACHED_DIAGNOSTIC) || defined(NODE_STDIO_DETACHED_CANDIDATE) || defined(NODE_STDIO_DETACHED_MATRIX)
constexpr DWORD creationFlag=DETACHED_PROCESS;
#ifdef NODE_STDIO_DETACHED_DIAGNOSTIC
constexpr char creationMode[]="detached-control-diagnostic";
#elif defined(NODE_STDIO_DETACHED_MATRIX)
constexpr char creationMode[]="detached-matrix-candidate";
#else
constexpr char creationMode[]="detached-normal-candidate";
#endif
#else
constexpr DWORD creationFlag=CREATE_NO_WINDOW;
constexpr char creationMode[]="no-window-candidate";
#endif
const std::vector<std::wstring> cases={L"normal",L"fail",L"owner-loss",L"owner-early",L"stalled-reader",L"startup-fail",L"invalid-utf8"};
std::string hex(const std::vector<BYTE>& bytes){std::string s;for(BYTE b:bytes){s+="0123456789abcdef"[b>>4];s+="0123456789abcdef"[b&15];}return s;}
std::string sha(HANDLE file) {
    BCRYPT_ALG_HANDLE a=nullptr;BCRYPT_HASH_HANDLE h=nullptr;std::vector<BYTE> value(32),buffer(65536);
    if(BCryptOpenAlgorithmProvider(&a,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("hash-provider");
    try {
        if(BCryptCreateHash(a,&h,nullptr,0,nullptr,0,0)<0)throw WinError("hash-create");
        size_t total=0;for(;;){DWORD n=0;if(!ReadFile(file,buffer.data(),65536,&n,nullptr))throw WinError("hash-read");if(!n)break;
            if((total+=n)>160*1024*1024)throw WinError("hash-limit",ERROR_INVALID_DATA);
            if(BCryptHashData(h,buffer.data(),n,0)<0)throw WinError("hash-data");}
        if(BCryptFinishHash(h,value.data(),32,0)<0)throw WinError("hash-finish");
    }catch(...){if(h)BCryptDestroyHash(h);BCryptCloseAlgorithmProvider(a,0);throw;}
    BCryptDestroyHash(h);BCryptCloseAlgorithmProvider(a,0);return hex(value);
}
void prepare(const std::wstring& root,PSID sid,Pins& pins) {
    std::vector<std::wstring> top={L"owner.marker",L"launcher",L"package",L"scratch",L"private",L"aap"};if(sid)top.push_back(L"profile.receipt");exactEntries(root,top);
    exactEntries(root+L"\\package",{L"node.exe",L"node-stdio-probe.mjs",L"node-stdio-wire.mjs",L"package.json",L"allowed.txt",L"code.txt"});
    exactEntries(root+L"\\launcher",{L"node-stdio-host.exe"});exactEntries(root+L"\\private",{L"secret.txt"});exactEntries(root+L"\\scratch",{});exactEntries(root+L"\\aap",{L"read.txt"});
    for(const auto& dir:{L"package",L"launcher",L"private",L"scratch",L"aap"})regular(root+L"\\"+dir,true);
    std::vector<std::wstring> leaves={L"owner.marker",L"launcher\\node-stdio-host.exe",L"private\\secret.txt",L"aap\\read.txt",L"package\\code.txt"};
    if(sid)leaves.push_back(L"profile.receipt");for(const auto& pin:stdioPins)leaves.push_back(L"package\\"+std::wstring(pin.name));
    for(const auto& leaf:leaves){regular(root+L"\\"+leaf,false);setOwnedAcl(root+L"\\"+leaf,nullptr,0,false);}
    setOwnedAcl(root+L"\\launcher",nullptr,0,false);setOwnedAcl(root+L"\\private",nullptr,0,false);
    setOwnedAcl(root+L"\\package",sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    setOwnedAcl(root+L"\\package\\code.txt",sid,FILE_GENERIC_READ,false);
    for(const auto& pin:stdioPins){const auto path=root+L"\\package\\"+pin.name;
        setOwnedAcl(path,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);if(sha(pins.add(path))!=pin.hash)throw WinError("resource-hash",ERROR_INVALID_DATA);}
    setOwnedAcl(root+L"\\scratch",sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE,true);lowScratch(root+L"\\scratch");
    PSID aap=nullptr;if(!ConvertStringSidToSidW(L"S-1-15-2-1",&aap))throw WinError("aap-sid");
    try{setOwnedAcl(root+L"\\aap",nullptr,0,false,aap);setOwnedAcl(root+L"\\aap\\read.txt",nullptr,0,false,aap);}catch(...){LocalFree(aap);throw;}LocalFree(aap);
    setOwnedAcl(root,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
}
struct Diagnostics {
    Handle done;std::thread thread;std::vector<BYTE> bytes;std::atomic<bool> failed{false};
    Diagnostics(HANDLE input,HANDLE job){done.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!done.value)throw WinError("stderr-event");
        thread=std::thread([this,input,job]{BYTE b[1024];DWORD n=0;
            while(ReadFile(input,b,sizeof(b),&n,nullptr)&&n){if(bytes.size()+n>16384){failed.store(true);TerminateJobObject(job,42);break;}bytes.insert(bytes.end(),b,b+n);}
            const auto error=GetLastError();if(error!=ERROR_BROKEN_PIPE&&error!=ERROR_SUCCESS)failed.store(true);SetEvent(done.value);});}
    void finish(){if(!thread.joinable())return;if(WaitForSingleObject(done.value,2000)!=WAIT_OBJECT_0){failed.store(true);CancelSynchronousIo(thread.native_handle());if(WaitForSingleObject(done.value,1000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),74);}thread.join();}
    ~Diagnostics(){finish();}
};
struct Wire {
    HANDLE input,output;Session session;size_t sent=0,received=0,sentBytes=0,receivedBytes=0;
    void request(Op op,uint32_t id,const std::vector<BYTE>& body={},bool fragmented=false){auto b=encode({op,id,session,body});
        if(++sent>20||(sentBytes+=b.size())>65536)throw WinError("request-budget",ERROR_INVALID_DATA);
        if(fragmented){for(BYTE v:b)writeAll(output,&v,1);}else writeAll(output,b.data(),b.size());}
    Frame response(Op op,uint32_t id){auto f=receive(input,session);if(++received>20||(receivedBytes+=headerSize+f.body.size())>65536||f.op!=op||f.id!=id)throw WinError("response-contract",ERROR_INVALID_DATA);
        emit("{\"type\":\"worker-frame\",\"op\":"+std::to_string(static_cast<unsigned>(f.op))+",\"id\":"+std::to_string(f.id)+",\"bodyHex\":\""+hex(f.body)+"\"}");return f;}
};
void noConsole(DWORD pid){
    DWORD list[2]={};if(GetConsoleProcessList(list,2)!=0)throw WinError("broker-console",ERROR_INVALID_DATA);
    const HANDLE in=GetStdHandle(STD_INPUT_HANDLE),out=GetStdHandle(STD_OUTPUT_HANDLE),err=GetStdHandle(STD_ERROR_HANDLE);
    if(AttachConsole(pid)){FreeConsole();SetStdHandle(STD_INPUT_HANDLE,in);SetStdHandle(STD_OUTPUT_HANDLE,out);SetStdHandle(STD_ERROR_HANDLE,err);throw WinError("unexpected-console",ERROR_INVALID_DATA);}
    if(GetLastError()!=ERROR_INVALID_HANDLE)throw WinError("console-observation");
}
void tail(HANDLE input){DWORD n=0;if(PeekNamedPipe(input,nullptr,0,nullptr,&n,nullptr)){if(n)throw WinError("response-tail",ERROR_INVALID_DATA);}else if(GetLastError()!=ERROR_BROKEN_PIPE)throw WinError("response-tail");}
}
int wmain(int argc,wchar_t** argv){
    Handle standard[3];
    Handle job(CreateJobObjectW(nullptr,nullptr)),child,parentWrite,parentRead,errorRead;Pins pins;
    std::unique_ptr<OwnerInput> owner;std::unique_ptr<Watchdog> watchdog;std::unique_ptr<Diagnostics> diagnostics;
    PSID sid=nullptr;bool created=false,passed=false,stopped=false,deleted=false,launched=false,childCreated=false,childResumed=false;std::wstring root,profile,kind;std::string failure;DWORD error=0,exitCode=0;int reason=0;
    try{
        if(argc!=6||std::wstring(argv[1])!=L"run")throw WinError("arguments",ERROR_INVALID_PARAMETER);
        const std::wstring mode=argv[2];kind=argv[5];profile=argv[3];
        if(!ownedProfile(profile,prefix)||(mode!=L"control"&&mode!=L"ac"&&mode!=L"lpac")||std::find(cases.begin(),cases.end(),kind)==cases.end())throw WinError("scope",ERROR_INVALID_PARAMETER);
#ifdef NODE_STDIO_DETACHED_DIAGNOSTIC
        if(mode!=L"control"||kind!=L"normal")throw WinError("diagnostic-scope",ERROR_INVALID_PARAMETER);
#endif
#ifdef NODE_STDIO_DETACHED_CANDIDATE
        if(kind!=L"normal")throw WinError("candidate-scope",ERROR_INVALID_PARAMETER);
#endif
#ifdef NODE_STDIO_DETACHED_MATRIX
        if(mode==L"ac"&&kind!=L"normal")throw WinError("matrix-scope",ERROR_INVALID_PARAMETER);
#endif
        if(!job.value)throw WinError("job");
        // Detach only this owned broker, retaining its three inherited pipes.
        // The driver's console and other processes are never modified.
        DWORD ownConsole[2]={};
        if(GetConsoleProcessList(ownConsole,2)!=0){
            const DWORD names[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
            for(size_t i=0;i<3;++i){const auto h=GetStdHandle(names[i]);if(GetFileType(h)!=FILE_TYPE_PIPE||!DuplicateHandle(GetCurrentProcess(),h,GetCurrentProcess(),&standard[i].value,0,FALSE,DUPLICATE_SAME_ACCESS))throw WinError("broker-stdio");}
            if(!FreeConsole())throw WinError("broker-detach");
            for(size_t i=0;i<3;++i)if(!SetStdHandle(names[i],standard[i].value))throw WinError("broker-restore");
        }
        SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS);SetProcessAffinityMask(GetCurrentProcess(),1);
        DWORD_PTR affinity=0,system=0;if(!GetProcessAffinityMask(GetCurrentProcess(),&affinity,&system)||affinity!=1||GetPriorityClass(GetCurrentProcess())!=BELOW_NORMAL_PRIORITY_CLASS)throw WinError("broker-limits");
        owner=std::make_unique<OwnerInput>(GetStdHandle(STD_INPUT_HANDLE),Session{});
        watchdog=std::make_unique<Watchdog>(job.value,kind==L"stalled-reader"?5000:20000,&owner->lost);
        root=ownedRoot(argv[4],marker);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit=1;limits.BasicLimitInformation.Affinity=1;limits.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS;limits.JobMemoryLimit=512ULL*1024*1024;
        if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw WinError("job-limits");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual={};if(!QueryInformationJobObject(job.value,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr)||actual.BasicLimitInformation.LimitFlags!=limits.BasicLimitInformation.LimitFlags||actual.BasicLimitInformation.ActiveProcessLimit!=1||actual.BasicLimitInformation.Affinity!=1||actual.BasicLimitInformation.PriorityClass!=BELOW_NORMAL_PRIORITY_CLASS||actual.JobMemoryLimit!=limits.JobMemoryLimit)throw WinError("job-readback");
        if(mode!=L"control"){const auto hr=CreateAppContainerProfile(profile.c_str(),L"Tahtiapuri stdio probe",L"Synthetic Node only",nullptr,0,&sid);if(FAILED(hr))throw WinError("create-profile",static_cast<DWORD>(hr));created=true;receipt(root,profile,true);}
        watchdog->checkOwner(&owner->lost);prepare(root,sid,pins);watchdog->checkOwner(&owner->lost);
        Handle childRead,childWrite,errorWrite;SECURITY_ATTRIBUTES sa={sizeof(sa),nullptr,TRUE};
        auto pipe=[&](Handle& read,Handle& write,bool parentReads){if(!CreatePipe(&read.value,&write.value,&sa,4096)||!SetHandleInformation(parentReads?read.value:write.value,HANDLE_FLAG_INHERIT,0))throw WinError("pipes");};
        pipe(childRead,parentWrite,false);pipe(parentRead,childWrite,true);pipe(errorRead,errorWrite,true);
        Handle sentinel(CreateFileW((root+L"\\private\\secret.txt").c_str(),GENERIC_READ,FILE_SHARE_READ,&sa,OPEN_EXISTING,0,nullptr));if(sentinel.value==INVALID_HANDLE_VALUE)throw WinError("sentinel");
        RegistryReadCapability registry;SECURITY_CAPABILITIES caps={};caps.AppContainerSid=sid;if(mode==L"lpac"){registry.derive();caps.Capabilities=&registry.entry;caps.CapabilityCount=1;}
        DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;Attributes attrs(mode==L"lpac"?4:mode==L"ac"?3:2);
        HANDLE inherited[]={childRead.value,childWrite.value,errorWrite.value};attrs.put(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited));attrs.put(PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.value,sizeof(job.value));
        if(sid)attrs.put(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps));if(mode==L"lpac")attrs.put(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy));
        STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attrs.list;startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=childRead.value;startup.StartupInfo.hStdOutput=childWrite.value;startup.StartupInfo.hStdError=errorWrite.value;
        Session session={};if(BCryptGenRandom(nullptr,session.data(),32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)throw WinError("random");
        const auto image=root+L"\\package\\node.exe";
        auto command=quote(image)+L" --preserve-symlinks --preserve-symlinks-main "+quote(root+L"\\package\\node-stdio-probe.mjs")+L" "+quote(root)+L" "+quote(kind)+L" "+sessionText(session);
        auto env=environment(root);PROCESS_INFORMATION pi={};watchdog->checkOwner(&owner->lost);
        if(!CreateProcessW(image.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|creationFlag,env.data(),(root+L"\\package").c_str(),&startup.StartupInfo,&pi))throw WinError("create-child");
        child.value=pi.hProcess;childCreated=true;Handle thread(pi.hThread);close(childRead);close(childWrite);close(errorWrite);
        const auto token=inspectToken(child.value);const auto exact=inspectCapabilities(child.value);requireCapabilities(exact,mode==L"lpac");
        BOOL member=FALSE;if(!IsProcessInJob(child.value,job.value,&member)||!member||activeCount(job.value)!=1||!GetProcessAffinityMask(child.value,&affinity,&system)||affinity!=1||GetPriorityClass(child.value)!=BELOW_NORMAL_PRIORITY_CLASS||sentinelInherited(child.value,sentinel.value))throw WinError("process-readback",ERROR_ACCESS_DENIED);
        if(sid){if(!token.app||token.integrity!=SECURITY_MANDATORY_LOW_RID||token.sid!=capabilitySidText(sid)||(token.lpac>=0&&token.lpac!=(mode==L"lpac"?1:0))||(token.lpac<0&&token.lpacQueryError!=ERROR_INVALID_PARAMETER))throw WinError("token-readback",ERROR_ACCESS_DENIED);}else if(token.app||token.capabilities)throw WinError("control-token",ERROR_ACCESS_DENIED);
        noConsole(pi.dwProcessId);
        emit("{\"type\":\"launched\",\"pid\":"+std::to_string(pi.dwProcessId)+",\"requestedPolicy\":\""+ascii(mode)+"\",\"creationMode\":\""+creationMode+"\",\"appContainer\":"+(token.app?"true":"false")+",\"lpac\":"+jsonFlag(token.lpac)+",\"lpacQueryError\":"+std::to_string(token.lpacQueryError)+",\"lpacQueryBytes\":"+std::to_string(token.lpacQueryBytes)+",\"capabilitySids\":"+capabilityJson(exact)+",\"integrity\":"+std::to_string(token.integrity)+",\"job\":true,\"activeProcessLimit\":1,\"affinity\":1,\"priority\":\"BelowNormal\",\"jobCommitBytes\":536870912,\"sentinelInherited\":false,\"aclsVerified\":true,\"consoleAbsent\":true,\"networkVerified\":false}");launched=true;
        if(kind==L"owner-early"){emit("{\"type\":\"await-owner\"}");while(!owner->lost.load())Sleep(10);if(!stopJob(job.value)||!expectedExit(child.value,42))throw WinError("early-stop");}
        else {
            watchdog->checkOwner(&owner->lost);diagnostics=std::make_unique<Diagnostics>(errorRead.value,job.value);if(ResumeThread(thread.value)==static_cast<DWORD>(-1))throw WinError("resume");childResumed=true;
            Wire wire{parentRead.value,parentWrite.value,session};
            if(kind==L"startup-fail"){if(!expectedExit(child.value,19))throw WinError("startup-error");}
            else {
                if(kind!=L"stalled-reader")wire.request(Op::hello,1);wire.response(Op::ready,1);noConsole(pi.dwProcessId);
                if(kind==L"owner-loss"){emit("{\"type\":\"await-owner\"}");while(!owner->lost.load())Sleep(10);if(!stopJob(job.value)||!expectedExit(child.value,42))throw WinError("owner-stop");}
                else if(kind==L"fail"){wire.request(Op::crash,2);if(!expectedExit(child.value,17))throw WinError("js-error");}
                else if(kind==L"invalid-utf8"){wire.request(Op::echo,2,{255});if(!expectedExit(child.value,65))throw WinError("utf8-error");}
                else if(kind==L"stalled-reader"){
                    wire.response(Op::pending,2);bool blocked=false;
                    try{wire.request(Op::echo,3,std::vector<BYTE>(maxPayload,'S'));}catch(const WinError& e){blocked=std::string(e.what())=="channel-write";}
                    if(!blocked||watchdog->reason.load()!=2||!expectedExit(child.value,42))throw WinError("write-deadline");
                }else {
                    const std::vector<BYTE> payload={'k','u','u'};wire.request(Op::echo,2,payload,true);if(wire.response(Op::echoed,2).body!=payload)throw WinError("echo");
                    const std::vector<BYTE> max(maxPayload,'X');wire.request(Op::echo,3,max);if(wire.response(Op::echoed,3).body!=max)throw WinError("max-echo");
                    wire.request(Op::shutdown,4);close(parentWrite);if(!wire.response(Op::bye,4).body.empty()||!expectedExit(child.value,0))throw WinError("shutdown");
                }
            }
            if(!GetExitCodeProcess(child.value,&exitCode))throw WinError("exit-code");tail(parentRead.value);
        }
        if(!GetExitCodeProcess(child.value,&exitCode))throw WinError("exit-code");
        passed=true;
    }catch(const WinError& e){failure=e.what();error=e.code;}catch(...){failure="unexpected";error=ERROR_INVALID_DATA;}
    stopped=job.value&&stopJob(job.value);
    if(stopped&&child.value&&!GetExitCodeProcess(child.value,&exitCode)){passed=false;failure="cleanup-exit-code";}
    if(diagnostics){diagnostics->finish();if(diagnostics->failed.load()){passed=false;failure="stderr-read";}emit("{\"type\":\"worker-stderr\",\"bodyHex\":\""+hex(diagnostics->bytes)+"\"}");diagnostics.reset();}
    const auto refreshWatchdog=[&]{
        if(watchdog)reason=watchdog->reason.load();
        const bool expected=kind==L"stalled-reader"?reason==2:(kind==L"owner-loss"||kind==L"owner-early")?(reason==0||reason==1):reason==0;
        if(!expected){passed=false;failure="unexpected-watchdog";}
    };
    refreshWatchdog();
    if(owner)owner->stop();
    if(created&&stopped){const auto hr=DeleteAppContainerProfile(profile.c_str());deleted=SUCCEEDED(hr);}else deleted=!created;
    if(sid)FreeSid(sid);
    passed=passed&&stopped&&deleted;refreshWatchdog();
    // Without a watchdog there is no bounded reporting channel.
    if(!watchdog)return 1;
    try { emit("{\"type\":\"result\",\"passed\":"+std::string(passed?"true":"false")+",\"launchReported\":"+(launched?"true":"false")+",\"childCreated\":"+(childCreated?"true":"false")+",\"childResumed\":"+(childResumed?"true":"false")+",\"exitCode\":"+std::to_string(exitCode)+",\"watchdog\":"+std::to_string(reason)+",\"jobEmpty\":"+(stopped?"true":"false")+",\"profileDeleted\":"+(deleted?"true":"false")+",\"failure\":\""+failure+"\",\"error\":"+std::to_string(error)+"}"); } catch(...) {passed=false;}
    // Owner storage outlives the watchdog, including final report I/O.
    refreshWatchdog();watchdog.reset();owner.reset();
    return passed?0:1;
}
