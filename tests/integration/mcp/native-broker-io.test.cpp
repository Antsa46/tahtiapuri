// Real Windows pipes and tiny synthetic child processes; no model or LPAC profile.
// The clock seam makes late completion observation deterministic without sleeps.
#include "../../../apps/mcp/native/broker-io.h"
#include <iostream>

namespace {
using namespace mcp_runtime;
void check(bool value,const char* reason){if(!value)throw std::runtime_error(reason);}
template<class Action> void failure(Action action,const char* expected){
    try{action();}catch(const WinError& e){check(std::string(e.what())==expected,"unexpected-win-error");return;}
    throw std::runtime_error("missing-win-error");
}
struct Pipe {
    Handle read,write;
    explicit Pipe(DWORD size=4096){if(!CreatePipe(&read.value,&write.value,nullptr,size))throw WinError("test-pipe");}
};
std::atomic<uint64_t> testNow{1000};
uint64_t controlledClock(){return testNow.load();}
std::atomic<unsigned> clockCalls{0};
unsigned expireAt=1;
uint64_t completionClock(){return clockCalls.fetch_add(1)>=expireAt?3000:1000;}
struct AsyncPipe {
    Handle read,write;
    AsyncPipe(){
        const auto name=L"\\\\.\\pipe\\Tahtiapuri.Mcp.IoTest."+std::to_wstring(GetCurrentProcessId());
        write.value=CreateNamedPipeW(name.c_str(),PIPE_ACCESS_OUTBOUND|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,nullptr);
        if(write.value==INVALID_HANDLE_VALUE)throw WinError("test-async-pipe");
        read.value=CreateFileW(name.c_str(),GENERIC_READ,0,nullptr,OPEN_EXISTING,0,nullptr);
        if(read.value==INVALID_HANDLE_VALUE)throw WinError("test-async-client");
        Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!event.value)throw WinError("test-connect-event");
        OVERLAPPED operation={};operation.hEvent=event.value;
        if(!ConnectNamedPipe(write.value,&operation)&&GetLastError()!=ERROR_PIPE_CONNECTED)throw WinError("test-connect");
    }
};
void readExact(HANDLE pipe,const Bytes& expected){
    Bytes actual(expected.size());DWORD count=0;
    if(!ReadFile(pipe,actual.data(),static_cast<DWORD>(actual.size()),&count,nullptr))throw WinError("test-read");
    check(count==actual.size()&&actual==expected,"physical-bytes-differ");
}
void overlappedCompletion(){
    const Bytes bytes{'d','o','n','e'};
    {AsyncPipe pipe;testNow.store(1000);
        check(overlappedIo(pipe.write.value,const_cast<uint8_t*>(bytes.data()),4,true,3000,nullptr,controlledClock)==4,"timely-completion");
        readExact(pipe.read.value,bytes);}
    {AsyncPipe pipe;clockCalls.store(0);expireAt=1;
        failure([&]{overlappedIo(pipe.write.value,const_cast<uint8_t*>(bytes.data()),4,true,3000,nullptr,completionClock);},"mcp-io-deadline");
        // The bytes were physically written successfully. The error is the
        // late observation, not a broken pipe or a cancelled pending operation.
        readExact(pipe.read.value,bytes);}
    {AsyncPipe pipe;testNow.store(3000);
        failure([&]{overlappedIo(pipe.write.value,const_cast<uint8_t*>(bytes.data()),4,true,3000,nullptr,controlledClock);},"mcp-io-deadline");
        DWORD count=0;check(PeekNamedPipe(pipe.read.value,nullptr,0,nullptr,&count,nullptr)&&count==0,"expired-io-started");}
}
void writerCompletion(){
    // The final successful WriteFile must not release the queued reservation
    // if the deadline passes either at completion or while acquiring its lock.
    for(unsigned boundary:{2u,3u}){
        Pipe pipe;clockCalls.store(0);expireAt=boundary;
        BrokerWriter writer(pipe.write.value,false,1,completionClock);writer.bytes(Bytes{'x'});
        const auto end=clockNow()+3000;
        while(!writer.failed()&&!writer.idle()&&clockNow()<end)Sleep(1);
        check(writer.failed()&&!writer.idle(),"late-writer-became-idle");
        readExact(pipe.read.value,Bytes{'x'});writer.stop();
    }
    // Real backpressure: the write is in progress when the test clock crosses
    // its fixed deadline. The reader then allows the whole write to complete.
    Pipe pipe;testNow.store(1000);BrokerWriter writer(pipe.write.value,false,1,controlledClock);
    const Bytes expected(65536,0x5a);writer.bytes(expected);
    const auto end=clockNow()+5000;DWORD available=0;
    do{check(PeekNamedPipe(pipe.read.value,nullptr,0,nullptr,&available,nullptr)!=FALSE,"blocked-write-peek");if(!available)Sleep(1);}
    while(!available&&clockNow()<end);
    check(available>0&&!writer.idle(),"write-did-not-block");testNow.store(3000);
    Bytes actual;actual.reserve(expected.size());
    while(actual.size()<expected.size()){
        check(clockNow()<end,"blocked-write-read-timeout");
        check(PeekNamedPipe(pipe.read.value,nullptr,0,nullptr,&available,nullptr)!=FALSE,"drain-peek");
        if(!available){Sleep(1);continue;}
        Bytes chunk(std::min<DWORD>(available,4096));DWORD count=0;
        check(ReadFile(pipe.read.value,chunk.data(),static_cast<DWORD>(chunk.size()),&count,nullptr)!=FALSE&&count>0,"drain-read");
        actual.insert(actual.end(),chunk.begin(),chunk.begin()+count);
    }
    while(!writer.failed()&&clockNow()<end)Sleep(1);
    check(actual==expected&&writer.failed()&&!writer.idle(),"blocked-late-write-was-success");writer.stop();
}
struct Child {
    Handle process,job,input,output,error;
    Child(const wchar_t* mode){
        SECURITY_ATTRIBUTES security={sizeof(security),nullptr,TRUE};
        Handle in,out,err;
        if(!CreatePipe(&in.value,&input.value,&security,4096)||!CreatePipe(&output.value,&out.value,&security,4096)||
           !CreatePipe(&error.value,&err.value,&security,4096))throw WinError("child-pipes");
        for(const auto handle:{input.value,output.value,error.value})
            if(!SetHandleInformation(handle,HANDLE_FLAG_INHERIT,0))throw WinError("child-inheritance");
        job.value=CreateJobObjectW(nullptr,nullptr);if(!job.value)throw WinError("child-job");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit=1;
        if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw WinError("child-job-limit");
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,2,0,&size);
        std::vector<uint8_t> storage(size);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if(!InitializeProcThreadAttributeList(list,2,0,&size))throw WinError("child-attributes");
        struct Release {LPPROC_THREAD_ATTRIBUTE_LIST list;~Release(){DeleteProcThreadAttributeList(list);}} release{list};
        HANDLE inherited[]={in.value,out.value,err.value};
        if(!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr)||
           !UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.value,sizeof(job.value),nullptr,nullptr))throw WinError("child-attribute");
        std::vector<wchar_t> module(32768);const auto count=GetModuleFileNameW(nullptr,module.data(),static_cast<DWORD>(module.size()));
        check(count>0&&count<module.size(),"child-module");
        const std::wstring executable(module.data(),count);auto command=quote(executable)+L" --emit "+mode;
        STARTUPINFOEXW start={};start.StartupInfo.cb=sizeof(start);start.lpAttributeList=list;
        start.StartupInfo.dwFlags=STARTF_USESTDHANDLES;start.StartupInfo.hStdInput=in.value;start.StartupInfo.hStdOutput=out.value;start.StartupInfo.hStdError=err.value;
        PROCESS_INFORMATION child={};
        if(!CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,
            nullptr,nullptr,&start.StartupInfo,&child))throw WinError("child-start");
        process.value=child.hProcess;Handle thread(child.hThread);
    }
    ~Child(){if(process.value&&WaitForSingleObject(process.value,0)!=WAIT_OBJECT_0){TerminateJobObject(job.value,1);WaitForSingleObject(process.value,3000);}}
    bool exited(){const auto result=WaitForSingleObject(process.value,0);check(result==WAIT_OBJECT_0||result==WAIT_TIMEOUT,"child-wait");return result==WAIT_OBJECT_0;}
    void requireExit(){check(WaitForSingleObject(process.value,3000)==WAIT_OBJECT_0,"child-timeout");DWORD exit=1;
        check(GetExitCodeProcess(process.value,&exit)&&exit==0,"child-exit-not-zero");}
};
int emitChild(const wchar_t* mode){
    // Read one complete CLOSE before emitting the chosen last stdout bytes.
    std::array<uint8_t,16> close={};DWORD count=0;
    if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),close.data(),16,&count,nullptr)||count!=16||
       close!=std::array<uint8_t,16>{'T','M','C','P',1,3,0,0,0,0,0,0,1,0,0,0})return 2;
    auto bytes=encodeBrokerFrame(Direction::FromWorker,{1,Bytes{'a','b','c'}},1);
    const std::wstring kind=mode;
    if(kind==L"header")bytes.resize(7);
    else if(kind==L"body")bytes.pop_back();
    else if(kind==L"empty")bytes.clear();
    else if(kind==L"rest")bytes.erase(bytes.begin(),bytes.begin()+5);
    else if(kind==L"tail"){auto next=encodeBrokerFrame(Direction::FromWorker,{4,{}},2);bytes.insert(bytes.end(),next.begin(),next.begin()+8);}
    else if(kind!=L"complete"&&kind!=L"stderr-limit"&&kind!=L"stderr-over")return 2;
    if(!bytes.empty()&&(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)||count!=bytes.size()))return 2;
    if(kind==L"stderr-limit"||kind==L"stderr-over"){
        Bytes errors(kind==L"stderr-limit"?16384:16385,'x');
        if(!WriteFile(GetStdHandle(STD_ERROR_HANDLE),errors.data(),static_cast<DWORD>(errors.size()),&count,nullptr)||count!=errors.size())return 2;
    }
    return 0;
}
void closeCompletion(){
    for(const auto mode:{L"complete",L"empty",L"rest",L"header",L"body",L"tail"}){
        Child child(mode);BrokerWriter writer(child.input.value,false,1);writer.frame(Direction::ToWorker,{3,{}});
        // Force the exact original failure ordering: child exit0 is already
        // observed and its final stdout bytes have not yet been consumed.
        child.requireExit();BrokerReader reader(Direction::FromWorker);
        if(std::wstring(mode)==L"rest"){auto bytes=encodeBrokerFrame(Direction::FromWorker,{1,Bytes{'a','b','c'}},1);reader.write(bytes.data(),5,clockNow(),[](BrokerFrame){});}
        bool ended=false;size_t stderrBytes=0;bool truncated=false;
        try{awaitWorkerClose(child.output.value,child.error.value,reader,ended,writer,stderrBytes,[&]{return child.exited();},clockNow()+2000);}
        catch(const WireError& e){check(std::string(e.what())=="truncated-frame","wrong-close-error");truncated=true;}
        const std::wstring kind=mode;
        check(truncated==(kind==L"header"||kind==L"body"||kind==L"tail"),"exit-zero-hid-truncated-frame");
        if(!truncated)check(ended&&writer.idle(),"close-without-eof");writer.stop();
    }
}
void stderrCompletion(){
    for(const auto mode:{L"stderr-limit",L"stderr-over"}){
        Child child(mode);BrokerWriter writer(child.input.value,false,1);writer.frame(Direction::ToWorker,{3,{}});
        BrokerReader reader(Direction::FromWorker);bool ended=false;size_t bytes=0;bool overflow=false;
        // Drain while the child is live: its final stderr write exceeds the
        // pipe buffer. Success still needs both EOFs and actual child exit0.
        try{awaitWorkerClose(child.output.value,child.error.value,reader,ended,writer,bytes,[&]{return child.exited();},clockNow()+2000);}
        catch(const WinError& e){check(std::string(e.what())=="mcp-stderr-bound","wrong-stderr-close-error");overflow=true;}
        child.requireExit();writer.stop();
        check(overflow==(std::wstring(mode)==L"stderr-over"),"stderr-tail-limit-bypassed");
        check(bytes==(overflow?16385u:16384u),"stderr-tail-not-drained");
    }
}
}
int wmain(int argc,wchar_t** argv){
    if(argc==3&&std::wstring(argv[1])==L"--emit")return emitChild(argv[2]);
    if(argc!=1)return 64;
    try{overlappedCompletion();writerCompletion();closeCompletion();stderrCompletion();
        std::cout<<"{\"passed\":true,\"suite\":\"native-mcp-broker-io-v1\",\"cases\":14}\n";return 0;}
    catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
