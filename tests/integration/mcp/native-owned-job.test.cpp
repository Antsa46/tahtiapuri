// Real, empty Windows Jobs only. No child, AppContainer, model or network.
// This consumer includes no backend headers or generated backend package pins.
#include "../../../packages/windows-runtime/native/owned-job.h"
#include <bcrypt.h>
#include <memory>
#pragma comment(lib,"bcrypt.lib")
#pragma comment(lib,"advapi32.lib")

namespace {
using namespace windows_runtime;
void check(bool value,const char* label){if(!value)throw WinError(label,ERROR_ASSERTION_FAILURE);}
template<class Action> void rejected(Action action,const char* label){try{action();}catch(const WinError&){return;}throw WinError(label,ERROR_ASSERTION_FAILURE);}
JOBOBJECT_EXTENDED_LIMIT_INFORMATION policy(){
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION value={};
    value.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_AFFINITY|JOB_OBJECT_LIMIT_PRIORITY_CLASS|JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    value.BasicLimitInformation.ActiveProcessLimit=1;value.BasicLimitInformation.Affinity=1;
    value.BasicLimitInformation.PriorityClass=BELOW_NORMAL_PRIORITY_CLASS;value.ProcessMemoryLimit=256ULL*1024*1024;
    return value;
}
std::wstring freshName(){
    BYTE nonce[16]={};if(BCryptGenRandom(nullptr,nonce,sizeof(nonce),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)throw WinError("test-nonce");
    std::wstring name=L"Local\\Tahtiapuri.Mcp.JobTest.";
    for(BYTE b:nonce){name+=L"0123456789abcdef"[b>>4];name+=L"0123456789abcdef"[b&15];}return name;
}
void run(){
    Owner owner;const auto name=freshName();auto limits=policy();
    // Names are trusted module policy, not worker input. Invalid API arguments
    // must not accidentally create an unnamed, unrecoverable Job.
    rejected([&]{OwnedJob bad(owner,L"",limits);},"empty-name-accepted");
    rejected([&]{OwnedJob bad(owner,std::wstring(L"a\0b",3),limits);},"embedded-null-accepted");
    rejected([&]{OwnedJob bad(owner,std::wstring(257,L'x'),limits);},"long-name-accepted");
    {
        OwnedJob job(owner,name,limits);check(!job.absent&&job.active()==0,"new-job-not-empty");
        verifyJobSecurity(job.handle.value,owner);verifyJobLimits(job.handle.value,limits);
        rejected([&]{OwnedJob collision(owner,name,limits);},"collision-accepted");
        check(job.active()==0,"collision-modified-job");
        {
            OwnedJob recovery(owner,name,limits,true);check(!recovery.absent&&recovery.active()==0,"reopen-failed");
            TerminationBudget budget(windowsProcessWitnessApi());recovery.terminateAndWait(budget);
            check(job.active()==0,"recovered-termination-not-empty");
        }
        auto wrong=limits;wrong.ProcessMemoryLimit*=2;
        rejected([&]{OwnedJob recovery(owner,name,wrong,true);},"wrong-policy-accepted");
        verifyJobLimits(job.handle.value,limits);
        check(SetHandleInformation(job.handle.value,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)!=FALSE,"test-inherit-set");
        rejected([&]{verifyJobLimits(job.handle.value,limits);},"inherited-handle-accepted");
        check(SetHandleInformation(job.handle.value,HANDLE_FLAG_INHERIT,0)!=FALSE,"test-inherit-reset");
        auto changed=limits;changed.BasicLimitInformation.ActiveProcessLimit=2;
        check(SetInformationJobObject(job.handle.value,JobObjectExtendedLimitInformation,&changed,sizeof(changed))!=FALSE,"test-limit-set");
        rejected([&]{verifyJobLimits(job.handle.value,limits);},"changed-limits-accepted");
        check(SetInformationJobObject(job.handle.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))!=FALSE,"test-limit-reset");
        verifyJobLimits(job.handle.value,limits);
    }
    OwnedJob absent(owner,name,limits,true);check(absent.absent&&absent.active()==0,"closed-job-still-exists");
    TerminationBudget budget(windowsProcessWitnessApi());
    rejected([&]{absent.terminateAndWait(budget);},"absent-handle-termination-accepted");
}
}
int wmain(){
    try{run();emit("{\"passed\":true,\"suite\":\"shared-owned-job-v1\",\"emptyJobsOnly\":true}");return 0;}
    catch(const WinError& error){emit("{\"passed\":false,\"stage\":\""+std::string(error.what())+"\",\"error\":"+std::to_string(error.code)+"}");return 1;}
    catch(...){emit("{\"passed\":false,\"stage\":\"unexpected-exception\"}");return 1;}
}
