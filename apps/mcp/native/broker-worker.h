#pragma once
#include "broker-journal.h"
#include "broker-io.h"
#include "../../../packages/windows-runtime/native/owned-job.h"
#include <cstddef>
#pragma comment(lib,"OneCoreUAP.lib")

namespace mcp_runtime {
inline constexpr wchar_t registryCapabilitySid[]=L"S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";
struct WorkerAttributes {
    std::vector<BYTE> storage;LPPROC_THREAD_ATTRIBUTE_LIST value=nullptr;
    explicit WorkerAttributes(DWORD count){SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,count,0,&size);if(!size)throw WinError("mcp-attributes-size");storage.resize(size);value=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());if(!InitializeProcThreadAttributeList(value,count,0,&size)){value=nullptr;throw WinError("mcp-attributes-init");}}
    void set(DWORD_PTR key,void* data,SIZE_T size){if(!UpdateProcThreadAttribute(value,0,key,data,size,nullptr,nullptr))throw WinError("mcp-attributes-set");}
    ~WorkerAttributes(){if(value)DeleteProcThreadAttributeList(value);}
};
struct RegistryCapability {
    PSID* groups=nullptr;DWORD groupCount=0;PSID* sids=nullptr;DWORD sidCount=0;SID_AND_ATTRIBUTES entry={};
    RegistryCapability(){
        if(!DeriveCapabilitySidsFromName(L"registryRead",&groups,&groupCount,&sids,&sidCount))throw WinError("mcp-capability-derive");
        if(sidCount!=1||!sids||windows_runtime::sidText(sids[0])!=registryCapabilitySid){release();throw WinError("mcp-capability-policy",ERROR_INVALID_SID);}entry={sids[0],SE_GROUP_ENABLED};
    }
    void release(){if(groups){for(DWORD i=0;i<groupCount;++i)LocalFree(groups[i]);LocalFree(groups);groups=nullptr;}if(sids){for(DWORD i=0;i<sidCount;++i)LocalFree(sids[i]);LocalFree(sids);sids=nullptr;}}
    ~RegistryCapability(){release();}
};
inline void verifyWorkerCapability(HANDLE process){
    Handle token;if(!OpenProcessToken(process,TOKEN_QUERY,&token.value))throw WinError("mcp-capability-token");auto bytes=tokenInfo(token.value,TokenCapabilities);
    if(bytes.size()<offsetof(TOKEN_GROUPS,Groups)+sizeof(SID_AND_ATTRIBUTES))throw WinError("mcp-capability-buffer",ERROR_INVALID_DATA);
    auto groups=reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());if(groups->GroupCount!=1||groups->Groups[0].Attributes!=SE_GROUP_ENABLED)throw WinError("mcp-capability-count",ERROR_ACCESS_DENIED);
    PSID sid=groups->Groups[0].Sid;const auto base=reinterpret_cast<ULONG_PTR>(bytes.data()),address=reinterpret_cast<ULONG_PTR>(sid);
    if(address<base||address-base>bytes.size()-8)throw WinError("mcp-capability-pointer",ERROR_INVALID_DATA);const auto raw=static_cast<SID*>(sid);
    if(raw->SubAuthorityCount>SID_MAX_SUB_AUTHORITIES||8+size_t(raw->SubAuthorityCount)*4>bytes.size()-(address-base)||windows_runtime::sidText(sid)!=registryCapabilitySid)throw WinError("mcp-capability-sid",ERROR_INVALID_SID);
}
struct BrokerOwnerPipes {
    Handle input,output,error;
    BrokerOwnerPipes(){Handle* handles[]={&input,&output,&error};const DWORD types[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
        for(size_t i=0;i<3;++i){auto pipe=GetStdHandle(types[i]);if(GetFileType(pipe)!=FILE_TYPE_PIPE||!DuplicateHandle(GetCurrentProcess(),pipe,GetCurrentProcess(),&handles[i]->value,0,FALSE,DUPLICATE_SAME_ACCESS))throw WinError("mcp-owner-pipe");}
        DWORD pids[2]={};if(GetConsoleProcessList(pids,2)&&!FreeConsole())throw WinError("mcp-broker-detach");restore();}
    void restore()const{if(!SetStdHandle(STD_INPUT_HANDLE,input.value)||!SetStdHandle(STD_OUTPUT_HANDLE,output.value)||!SetStdHandle(STD_ERROR_HANDLE,error.value))throw WinError("mcp-stdio-restore");}
    void noConsole(DWORD pid)const{
        DWORD pids[2]={};if(GetConsoleProcessList(pids,2))throw WinError("mcp-broker-console",ERROR_INVALID_DATA);
        if(AttachConsole(pid)){FreeConsole();restore();throw WinError("mcp-worker-console",ERROR_INVALID_DATA);}const auto errorCode=GetLastError();restore();if(errorCode!=ERROR_INVALID_HANDLE)throw WinError("mcp-console-observation",errorCode);
    }
};
inline void workerPipe(Handle& read,Handle& write,bool parentReads){SECURITY_ATTRIBUTES attributes={sizeof(attributes),nullptr,TRUE};if(!CreatePipe(&read.value,&write.value,&attributes,4096)||!SetHandleInformation(parentReads?read.value:write.value,HANDLE_FLAG_INHERIT,0))throw WinError("mcp-worker-pipe");}
inline JOBOBJECT_EXTENDED_LIMIT_INFORMATION mcpJobLimits(){
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit=1;limits.BasicLimitInformation.Affinity=1;limits.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS;limits.ProcessMemoryLimit=512ULL*1024*1024;return limits;
}
inline std::vector<wchar_t> workerEnvironment(const BrokerResources& resources){
    std::array<wchar_t,32768> windows={};const UINT count=GetWindowsDirectoryW(windows.data(),static_cast<UINT>(windows.size()));if(!count||count>=windows.size())throw WinError("mcp-windows-directory");const auto system=bootstrapPath(windows.data());
    std::vector<wchar_t> block;for(const auto& item:{L"APPDATA="+resources.scratch,L"LOCALAPPDATA="+resources.scratch,L"PATH="+system+L"\\System32",L"SystemRoot="+system,L"TEMP="+resources.scratch,L"TMP="+resources.scratch,L"USERPROFILE="+resources.scratch,L"WINDIR="+system}){block.insert(block.end(),item.begin(),item.end());block.push_back(0);}block.push_back(0);return block;
}
class BrokerWorker {
    BrokerResources& resources;BrokerJournal& journal;const BrokerOwnerPipes& ownerPipes;std::function<void()> ownerAlive;
    windows_runtime::Owner owner;std::unique_ptr<windows_runtime::OwnedJob> job;
    PSID profile=nullptr;bool profileOwned=false;Handle initialThread;
public:
    Handle process,input,output,error;DWORD pid=0,exitCode=STILL_ACTIVE;TokenView token;bool resumed=false,jobEmpty=false;
    BrokerWorker(BrokerResources& data,BrokerJournal& log,const BrokerOwnerPipes& pipes,std::function<void()> alive):resources(data),journal(log),ownerPipes(pipes),ownerAlive(std::move(alive)){}
    ~BrokerWorker(){if(profile)FreeSid(profile);}
    void prepare(){
        job=std::make_unique<windows_runtime::OwnedJob>(owner,journal.jobName,mcpJobLimits());ownerAlive();journal.creatingProfile();
        const HRESULT created=CreateAppContainerProfile(journal.profileName.c_str(),L"Tahtiapuri MCP",L"Restricted local MCP worker",nullptr,0,&profile);
        if(FAILED(created))throw WinError("mcp-profile-create",static_cast<DWORD>(created));journal.ownedProfile(profile);profileOwned=true;ownerAlive();resources.grant(profile);ownerAlive();
        Handle childRead,childWrite,errorWrite;workerPipe(childRead,input,false);workerPipe(output,childWrite,true);workerPipe(error,errorWrite,true);
        RegistryCapability registry;SECURITY_CAPABILITIES capabilities={};capabilities.AppContainerSid=profile;capabilities.Capabilities=&registry.entry;capabilities.CapabilityCount=1;
        DWORD policy=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;WorkerAttributes attributes(4);HANDLE inherited[]={childRead.value,childWrite.value,errorWrite.value};
        attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited));attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST,&job->handle.value,sizeof(job->handle.value));
        attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&capabilities,sizeof(capabilities));attributes.set(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&policy,sizeof(policy));
        STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes.value;startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput=childRead.value;startup.StartupInfo.hStdOutput=childWrite.value;startup.StartupInfo.hStdError=errorWrite.value;
        auto command=quote(resources.node)+L" --max-old-space-size=128 --preserve-symlinks --preserve-symlinks-main "+quote(resources.entry);auto environment=workerEnvironment(resources);PROCESS_INFORMATION createdProcess={};
        ownerAlive();journal.creatingProcess();
        if(!CreateProcessW(resources.node.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED|DETACHED_PROCESS,environment.data(),resources.package.c_str(),&startup.StartupInfo,&createdProcess))throw WinError("mcp-worker-create");
        process.value=createdProcess.hProcess;initialThread.value=createdProcess.hThread;pid=createdProcess.dwProcessId;
        journal.recordedProcess(pid,windows_runtime::windowsProcessWitnessApi().creationTime(process.value));
        closeNative(childRead);closeNative(childWrite);closeNative(errorWrite);
        windows_runtime::verifyJobSecurity(job->handle.value,owner);windows_runtime::verifyJobLimits(job->handle.value,mcpJobLimits());
        BOOL member=FALSE;DWORD_PTR affinity=0,system=0;
        if(!IsProcessInJob(process.value,job->handle.value,&member)||!member||job->active()!=1||!GetProcessAffinityMask(process.value,&affinity,&system)||affinity!=1||GetPriorityClass(process.value)!=BELOW_NORMAL_PRIORITY_CLASS)throw WinError("mcp-worker-job",ERROR_ACCESS_DENIED);
        token=inspectToken(process.value);verifyWorkerCapability(process.value);
        if(!token.app||token.integrity!=SECURITY_MANDATORY_LOW_RID||token.sid!=windows_runtime::sidText(profile)||token.capabilities!=1||
            (token.lpac!=1&&!(token.lpac==-1&&token.lpacQueryError==ERROR_INVALID_PARAMETER&&token.lpacQueryBytes==0)))throw WinError("mcp-worker-token",ERROR_ACCESS_DENIED);
        ownerPipes.noConsole(pid);
    }
    void start(){ownerAlive();journal.requireResume();if(ResumeThread(initialThread.value)==static_cast<DWORD>(-1))throw WinError("mcp-worker-resume");resumed=true;journal.running();}
    bool exited(){if(!process.value)return false;const auto result=WaitForSingleObject(process.value,0);if(result==WAIT_TIMEOUT)return false;if(result!=WAIT_OBJECT_0)throw WinError("mcp-worker-wait");if(!GetExitCodeProcess(process.value,&exitCode))throw WinError("mcp-worker-exit");return true;}
    void checkConsole()const{ownerPipes.noConsole(pid);}
    void cleanup(){
        // Termination always comes before journal mutations, including when a
        // previous journal write failed. Only our retained authenticated Job is used.
        if(!job)throw WinError("mcp-job-unowned",ERROR_INVALID_STATE);
        windows_runtime::TerminationBudget budget(windows_runtime::windowsProcessWitnessApi());job->terminateAndWait(budget);jobEmpty=true;
        if(process.value){const auto result=WaitForSingleObject(process.value,budget.remaining());budget.check();if(result!=WAIT_OBJECT_0||!GetExitCodeProcess(process.value,&exitCode))throw WinError("mcp-process-exit-unproven");}
        if(!journal.healthy())throw WinError("mcp-cleanup-journal-poisoned",ERROR_INVALID_STATE);journal.closing();
        if(profileOwned){const HRESULT removed=DeleteAppContainerProfile(journal.profileName.c_str());if(FAILED(removed))throw WinError("mcp-profile-delete",static_cast<DWORD>(removed));profileOwned=false;}
        resources.removeAfterExit();journal.clean();
    }
};
}
