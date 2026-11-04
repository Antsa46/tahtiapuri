#pragma once
#include "transport-wire.h"
#include "transport-resources.h"
#include <bcrypt.h>
#include <atomic>
#include <thread>
#include <memory>
namespace isolation {
using namespace transport;
struct Attributes {
    std::vector<BYTE> data; LPPROC_THREAD_ATTRIBUTE_LIST list=nullptr;
    explicit Attributes(DWORD count) {
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,count,0,&size);
        data.resize(size);list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(data.data());
        if(!InitializeProcThreadAttributeList(list,count,0,&size)) throw WinError("attributes");
    }
    ~Attributes(){if(list) DeleteProcThreadAttributeList(list);}
    void put(DWORD_PTR key,void* value,SIZE_T size) {
        if(!UpdateProcThreadAttribute(list,0,key,value,size,nullptr,nullptr)) throw WinError("attribute");
    }
};
bool ownedProfile(const std::wstring& profile,const std::wstring& prefix) {
    return profile.size()==prefix.size()+32 && profile.compare(0,prefix.size(),prefix)==0 &&
        std::all_of(profile.begin()+prefix.size(),profile.end(),[](wchar_t c){return (c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f');});
}
void close(Handle& h){if(h.value){CloseHandle(h.value);h.value=nullptr;}}
DWORD activeCount(HANDLE job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info={};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr)) throw WinError("job-count");
    return info.ActiveProcesses;
}
// Bounds synchronous channel writes AND diagnostic writes. The owner pipe,
// Job and process handles are never inherited by the worker.
struct Watchdog {
    Handle done,mainThread;std::thread thread;std::atomic<int> reason{0};
    Watchdog(HANDLE job,DWORD duration) {
        if(GetFileType(GetStdHandle(STD_INPUT_HANDLE))!=FILE_TYPE_PIPE) throw WinError("owner-channel",ERROR_INVALID_HANDLE);
        done.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);
        if(!done.value||!DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),
            &mainThread.value,THREAD_TERMINATE,FALSE,0)) throw WinError("watchdog-handles");
        thread=std::thread([this,job,duration] {
            const auto deadline=GetTickCount64()+duration;
            while(WaitForSingleObject(done.value,20)==WAIT_TIMEOUT) {
                DWORD available=0;int cause=0;
                if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),nullptr,0,nullptr,&available,nullptr)||available) cause=1;
                else if(GetTickCount64()>=deadline) cause=2;
                if(!cause) continue;
                reason.store(cause);
                TerminateJobObject(job,42);
                CancelSynchronousIo(mainThread.value);
                if(WaitForSingleObject(done.value,2000)==WAIT_TIMEOUT) TerminateProcess(GetCurrentProcess(),72);
                return;
            }
        });
    }
    ~Watchdog(){SetEvent(done.value);if(thread.joinable()) thread.join();}
};
void exactEntries(const std::wstring& path,std::vector<std::wstring> expected) {
    WIN32_FIND_DATAW info={};HANDLE search=FindFirstFileW((path+L"\\*").c_str(),&info);
    if(search==INVALID_HANDLE_VALUE) throw WinError("stage-enumeration");
    std::vector<std::wstring> actual;
    do {const std::wstring name=info.cFileName;if(name!=L"."&&name!=L"..") actual.push_back(name);}
    while(FindNextFileW(search,&info));
    const DWORD error=GetLastError();FindClose(search);
    std::sort(actual.begin(),actual.end());std::sort(expected.begin(),expected.end());
    if(error!=ERROR_NO_MORE_FILES||actual!=expected) throw WinError("stage-allowlist",ERROR_INVALID_DATA);
}
struct Pins {
    std::vector<std::unique_ptr<Handle>> handles;
    HANDLE add(const std::wstring& path) {
        auto h=std::make_unique<Handle>(CreateFileW(filePath(path).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        if(h->value==INVALID_HANDLE_VALUE) throw WinError("resource-pin");
        HANDLE value=h->value;handles.push_back(std::move(h));return value;
    }
};
std::wstring environment(const std::wstring& root) {
    wchar_t windows[2048]={};const auto size=GetWindowsDirectoryW(windows,2048);
    if(!size||size>=2048) throw WinError("windows-directory");
    std::wstring result;
    // Windows requires the environment entries to be sorted by name.
    for(const auto& entry:std::initializer_list<std::wstring>{L"APPDATA="+root+L"\\scratch",L"LOCALAPPDATA="+root+L"\\scratch",
        L"OMP_NUM_THREADS=1",L"OMP_THREAD_LIMIT=1",L"PATH="+std::wstring(windows)+L"\\System32",L"SystemRoot="+std::wstring(windows),
        L"TEMP="+root+L"\\scratch",L"TMP="+root+L"\\scratch",L"USERPROFILE="+root+L"\\scratch",L"WINDIR="+std::wstring(windows)}) {
        result+=entry;result+=L'\0';
    }
    result+=L'\0';return result;
}
bool expectedExit(HANDLE child,DWORD expected) {
    DWORD code=0;return WaitForSingleObject(child,3000)==WAIT_OBJECT_0&&GetExitCodeProcess(child,&code)&&code==expected;
}
struct Channel {
    HANDLE input,output;Session session;size_t frames=0,bytes=0;
    void request(Op op,uint32_t id,const std::vector<BYTE>& body={}) {send(output,{op,id,session,body});}
    Frame read() {
        Frame f=receive(input,session);bytes+=headerSize+f.body.size();
        if(++frames>32||bytes>256*1024) throw WinError("response-budget",ERROR_INVALID_DATA);
        return f;
    }
    void expect(Op op,uint32_t id,const std::vector<BYTE>& body={}) {
        const auto f=read();
        if(f.op!=op||f.id!=id||f.body!=body) throw WinError("response-contract",ERROR_INVALID_DATA);
    }
};
struct Experiment {
    const wchar_t* prefix;
    const char* marker;
    const wchar_t* worker;
    SIZE_T memoryBytes;
    std::vector<std::wstring> cases;
    DWORD (*deadline)(const std::wstring&);
    void (*prepare)(const std::wstring&,PSID,const std::wstring&,Pins&);
    void (*exercise)(const std::wstring&,Channel&,HANDLE,Handle&,HANDLE,Watchdog&);
};
inline int run(int argc,wchar_t** argv,const Experiment& spec) {
    Pins pins;
    PSID sid=nullptr;bool created=false;std::wstring profile;
    Handle job(CreateJobObjectW(nullptr,nullptr));
    if(!job.value) return 1;
    try {
        if(argc==5&&std::wstring(argv[1])==L"observe") {
            const std::wstring root=ownedRoot(argv[3],spec.marker);
            if(std::wstring(argv[4])!=L"worker") throw WinError("observer-scope",ERROR_INVALID_PARAMETER);
            const DWORD pid=boundedNumber(argv[2],MAXDWORD);
            Watchdog watchdog(job.value,20000);
            Handle child(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
            wchar_t image[2048]={};DWORD length=2048;
            if(!child.value||!QueryFullProcessImageNameW(child.value,0,image,&length)||
                _wcsicmp(image,(root+L"\\package\\"+spec.worker).c_str())!=0||
                WaitForSingleObject(child.value,0)!=WAIT_TIMEOUT) throw WinError("observer-identity",ERROR_ACCESS_DENIED);
            emit("{\"type\":\"observing\",\"pid\":"+std::to_string(pid)+",\"imageVerified\":true}");
            if(WaitForSingleObject(child.value,15000)!=WAIT_OBJECT_0) throw WinError("observer-deadline",ERROR_TIMEOUT);
            DWORD code=0;if(!GetExitCodeProcess(child.value,&code)) throw WinError("observer-exit");
            emit("{\"type\":\"observed-exit\",\"pid\":"+std::to_string(pid)+",\"exitCode\":"+std::to_string(code)+"}");return 0;
        }
        if(argc==4&&std::wstring(argv[1])==L"cleanup"&&ownedProfile(argv[2],spec.prefix)) {
            receipt(ownedRoot(argv[3],spec.marker),argv[2],false);
            const auto hr=DeleteAppContainerProfile(argv[2]);
            emit("{\"type\":\"cleanup\",\"hresult\":"+std::to_string(hr)+"}");return FAILED(hr)?1:0;
        }
        if(argc!=6||std::wstring(argv[1])!=L"run") throw WinError("arguments",ERROR_INVALID_PARAMETER);
        const std::wstring mode=argv[2],root=ownedRoot(argv[4],spec.marker),name=argv[5];profile=argv[3];
        if(!ownedProfile(profile,spec.prefix)||(mode!=L"control"&&mode!=L"ac"&&mode!=L"lpac")
            ||std::find(spec.cases.begin(),spec.cases.end(),name)==spec.cases.end()) throw WinError("scope",ERROR_INVALID_PARAMETER);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|
            JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit=1;limits.BasicLimitInformation.Affinity=1;
        limits.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS;limits.JobMemoryLimit=spec.memoryBytes;
        if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) throw WinError("job-limits");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual={};
        if(!QueryInformationJobObject(job.value,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr)
            ||actual.BasicLimitInformation.LimitFlags!=limits.BasicLimitInformation.LimitFlags
            ||actual.BasicLimitInformation.ActiveProcessLimit!=1||actual.BasicLimitInformation.Affinity!=1
            ||actual.BasicLimitInformation.PriorityClass!=BELOW_NORMAL_PRIORITY_CLASS||actual.JobMemoryLimit!=limits.JobMemoryLimit)
            throw WinError("job-readback",ERROR_INVALID_DATA);
        Watchdog watchdog(job.value,spec.deadline(name));
        bool passed=false;std::string failure;DWORD error=0;
        try {
            if(mode!=L"control") {
                const auto hr=CreateAppContainerProfile(profile.c_str(),L"Tahtiapuri transport probe",L"Temporary synthetic transport",nullptr,0,&sid);
                if(FAILED(hr)) throw WinError("create-profile",static_cast<DWORD>(hr));
                created=true;receipt(root,profile,true);
            }
            spec.prepare(root,sid,name,pins);
            const auto image=root+L"\\package\\"+spec.worker;
            pins.add(image);
            Handle childRead,parentWrite,parentRead,childWrite;
            SECURITY_ATTRIBUTES sa={sizeof(sa),nullptr,TRUE};
            if(!CreatePipe(&childRead.value,&parentWrite.value,&sa,4096)||!CreatePipe(&parentRead.value,&childWrite.value,&sa,4096)
                ||!SetHandleInformation(parentRead.value,HANDLE_FLAG_INHERIT,0)||!SetHandleInformation(parentWrite.value,HANDLE_FLAG_INHERIT,0))
                throw WinError("pipes");
            Handle nul(CreateFileW(L"NUL",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,nullptr));
            Handle sentinel(CreateFileW((root+L"\\private\\secret.txt").c_str(),GENERIC_READ,FILE_SHARE_READ,&sa,OPEN_EXISTING,0,nullptr));
            if(nul.value==INVALID_HANDLE_VALUE||sentinel.value==INVALID_HANDLE_VALUE) throw WinError("input-handles");
            HANDLE inherited[]={childRead.value,childWrite.value,nul.value};
            SECURITY_CAPABILITIES caps={};caps.AppContainerSid=sid;DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
            Attributes attrs(mode==L"lpac"?4:mode==L"ac"?3:2);
            attrs.put(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited));
            attrs.put(PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.value,sizeof(job.value));
            if(sid) attrs.put(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps));
            if(mode==L"lpac") attrs.put(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy));
            STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attrs.list;
            startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput=nul.value;startup.StartupInfo.hStdOutput=nul.value;startup.StartupInfo.hStdError=nul.value;
            Session session={};
            if(BCryptGenRandom(nullptr,session.data(),static_cast<ULONG>(session.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)
                throw WinError("random-session",ERROR_INVALID_DATA);
            auto command=quote(image)+L" "+std::to_wstring(reinterpret_cast<ULONG_PTR>(childRead.value))+L" "+
                std::to_wstring(reinterpret_cast<ULONG_PTR>(childWrite.value))+L" "+sessionText(session);
            auto env=environment(root);PROCESS_INFORMATION process={};
            if(!CreateProcessW(image.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|
                CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|DETACHED_PROCESS,env.data(),(root+L"\\package").c_str(),&startup.StartupInfo,&process))
                throw WinError("create-child");
            Handle child(process.hProcess),thread(process.hThread);close(childRead);close(childWrite);
            BOOL member=FALSE;DWORD_PTR affinity=0,system=0;
            if(!IsProcessInJob(child.value,job.value,&member)||!member||activeCount(job.value)!=1||
                !GetProcessAffinityMask(child.value,&affinity,&system)||affinity!=1||GetPriorityClass(child.value)!=BELOW_NORMAL_PRIORITY_CLASS||
                sentinelInherited(child.value,sentinel.value)) throw WinError("process-readback",ERROR_ACCESS_DENIED);
            const auto token=inspectToken(child.value);
            if((sid&&(!token.app||token.capabilities!=0||token.integrity!=SECURITY_MANDATORY_LOW_RID||
                (token.lpac>=0&&token.lpac!=(mode==L"lpac"?1:0))||(token.lpac<0&&token.lpacQueryError!=ERROR_INVALID_PARAMETER)))||
                (!sid&&(token.app||token.capabilities))) throw WinError("token-readback",ERROR_ACCESS_DENIED);
            if(sid) {
                LPWSTR expected=nullptr;if(!ConvertSidToStringSidW(sid,&expected)) throw WinError("sid");
                const bool same=token.sid==expected;LocalFree(expected);if(!same) throw WinError("sid-readback",ERROR_ACCESS_DENIED);
            }
            emit("{\"type\":\"launched\",\"requestedPolicy\":\""+ascii(mode)+"\",\"pid\":"+std::to_string(process.dwProcessId)+
                ",\"appContainer\":"+(token.app?"true":"false")+",\"lpac\":"+jsonFlag(token.lpac)+
                ",\"lpacQueryError\":"+std::to_string(token.lpacQueryError)+",\"lpacQueryBytes\":"+std::to_string(token.lpacQueryBytes)+
                ",\"capabilities\":"+std::to_string(token.capabilities)+",\"integrity\":"+std::to_string(token.integrity)+
                ",\"sid\":\""+ascii(token.sid)+"\",\"job\":true,\"activeProcessLimit\":1,\"affinity\":1,\"priority\":\"BelowNormal\","+
                "\"jobCommitBytes\":"+std::to_string(spec.memoryBytes)+",\"sentinelInherited\":false,\"aclsVerified\":true,\"networkVerified\":false}");
            if(ResumeThread(thread.value)==static_cast<DWORD>(-1)) throw WinError("resume");
            Channel channel{parentRead.value,parentWrite.value,session};
            spec.exercise(name,channel,child.value,parentWrite,job.value,watchdog);
            const auto emptyDeadline=GetTickCount64()+2000;
            while(activeCount(job.value)!=0&&GetTickCount64()<emptyDeadline) Sleep(10);
            if(activeCount(job.value)!=0) throw WinError("remaining-child",ERROR_INVALID_DATA);
            const int reason=watchdog.reason.load();
            if(reason!=0&&name!=L"owner-loss"&&name!=L"stalled-reader") throw WinError("unexpected-watchdog",ERROR_TIMEOUT);
            passed=true;
        } catch(const WinError& e){failure=e.what();error=e.code;}
          catch(...){failure="exception";error=ERROR_INVALID_DATA;}
        // Unexpected failures are never accepted because emergency cleanup succeeded.
        const bool empty=stopJob(job.value);
        bool cleaned=!created;
        if(created&&empty){const auto hr=DeleteAppContainerProfile(profile.c_str());cleaned=SUCCEEDED(hr);if(cleaned) created=false;}
        if(sid){FreeSid(sid);sid=nullptr;}
        emit("{\"type\":\"result\",\"case\":\""+ascii(name)+"\",\"passed\":"+(passed&&empty&&cleaned?"true":"false")+
            ",\"jobEmpty\":"+(empty?"true":"false")+",\"profileDeleted\":"+(cleaned?"true":"false")+
            ",\"watchdogReason\":"+std::to_string(watchdog.reason.load())+",\"failure\":\""+failure+"\",\"error\":"+std::to_string(error)+"}");
        return passed&&empty&&cleaned?0:1;
    } catch(const WinError&) {
        const bool empty=stopJob(job.value);
        if(created&&empty) DeleteAppContainerProfile(profile.c_str());
        if(sid) FreeSid(sid);
        // No synchronous report outside the watchdog lifetime.
        return 1;
    }
}

}
