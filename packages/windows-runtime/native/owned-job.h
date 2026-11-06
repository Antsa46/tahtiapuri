#pragma once
#include "owner-security.h"
#include "process-witness.h"

namespace windows_runtime {
inline SECURITY_ATTRIBUTES jobAttributes(const Owner& owner,LocalMemory& descriptor) {
    auto text=L"O:"+owner.text+L"D:P(A;;0x001f003f;;;"+owner.text+L")(A;;0x001f003f;;;SY)";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value),nullptr))throw WinError("job-descriptor");
    return {sizeof(SECURITY_ATTRIBUTES),descriptor.value,FALSE};
}
inline void verifyJobSecurity(HANDLE job,const Owner& owner) {
    LocalMemory descriptor;PSID actualOwner=nullptr;PACL acl=nullptr;DWORD error=GetSecurityInfo(job,SE_KERNEL_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
        &actualOwner,nullptr,&acl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;
    if(error||!actualOwner||!EqualSid(actualOwner,owner.sid())||!GetSecurityDescriptorControl(descriptor.value,&control,&revision)||!(control&SE_DACL_PROTECTED)||!acl||acl->AceCount!=2)throw WinError("job-security",error?error:ERROR_INVALID_ACL);
    bool user=false,system=false;for(DWORD i=0;i<2;++i){void* raw=nullptr;if(!GetAce(acl,i,&raw))throw WinError("job-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if(ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE||ace->Header.AceFlags||ace->Mask!=JOB_OBJECT_ALL_ACCESS)throw WinError("job-ace-policy",ERROR_INVALID_ACL);
        if(EqualSid(&ace->SidStart,owner.sid())&&!user)user=true;else if(EqualSid(&ace->SidStart,owner.system.value)&&!system)system=true;else throw WinError("job-ace-sid",ERROR_INVALID_ACL);}
    if(!user||!system)throw WinError("job-ace-count",ERROR_INVALID_ACL);
}
inline void verifyJobLimits(HANDLE job,const JOBOBJECT_EXTENDED_LIMIT_INFORMATION& expected) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual={};
    if(!QueryInformationJobObject(job,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr)||
        actual.BasicLimitInformation.LimitFlags!=expected.BasicLimitInformation.LimitFlags||actual.BasicLimitInformation.ActiveProcessLimit!=expected.BasicLimitInformation.ActiveProcessLimit||
        actual.BasicLimitInformation.Affinity!=expected.BasicLimitInformation.Affinity||actual.BasicLimitInformation.PriorityClass!=expected.BasicLimitInformation.PriorityClass||actual.ProcessMemoryLimit!=expected.ProcessMemoryLimit||
        actual.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart||actual.BasicLimitInformation.PerJobUserTimeLimit.QuadPart||actual.BasicLimitInformation.MinimumWorkingSetSize||
        actual.BasicLimitInformation.MaximumWorkingSetSize||actual.JobMemoryLimit)throw WinError("job-limit-readback",ERROR_INVALID_DATA);
    DWORD flags=0;if(!GetHandleInformation(job,&flags)||(flags&HANDLE_FLAG_INHERIT))throw WinError("job-noninherited",ERROR_INVALID_DATA);
}
class OwnedJob {
    const Owner& owner;
    const JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
public:
    std::wstring name;Handle handle;bool absent=false;
    OwnedJob(const Owner& user,const std::wstring& expectedName,const JOBOBJECT_EXTENDED_LIMIT_INFORMATION& expectedLimits,bool recovering=false)
        :owner(user),limits(expectedLimits),name(expectedName) {
        // The owning module derives this name from its authenticated journal and
        // validates its own policy. Worker-controlled names never reach this API.
        if(name.empty()||name.size()>256||name.find(L'\0')!=std::wstring::npos)throw WinError("job-name",ERROR_INVALID_NAME);
        if(recovering){handle.value=OpenJobObjectW(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE|READ_CONTROL,FALSE,name.c_str());
            if(!handle.value){DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND){absent=true;return;}throw WinError("recover-job-open",error);}}
        else {LocalMemory sd;auto sa=jobAttributes(owner,sd);SetLastError(ERROR_SUCCESS);handle.value=CreateJobObjectW(&sa,name.c_str());DWORD error=GetLastError();
            if(!handle.value)throw WinError("job-create",error);if(error==ERROR_ALREADY_EXISTS)throw WinError("job-name-collision",error);
            auto applied=limits;if(!SetInformationJobObject(handle.value,JobObjectExtendedLimitInformation,&applied,sizeof(applied)))throw WinError("job-set-limits");}
        verifyJobSecurity(handle.value,owner);verifyJobLimits(handle.value,limits);
    }
    DWORD active() const {
        if(absent)return 0;JOBOBJECT_BASIC_ACCOUNTING_INFORMATION stats={};if(!QueryInformationJobObject(handle.value,JobObjectBasicAccountingInformation,&stats,sizeof(stats),nullptr))throw WinError("job-active-query");return stats.ActiveProcesses;
    }
    void terminateAndWait(TerminationBudget& budget) {
        if(absent)throw WinError("job-termination-handle-missing",ERROR_INVALID_STATE);
        budget.check();verifyJobSecurity(handle.value,owner);budget.check();verifyJobLimits(handle.value,limits);budget.check();
        // An open recovery handle prevents last-handle death; explicit terminate is required.
        if(!TerminateJobObject(handle.value,42))throw WinError("job-terminate");budget.check();
        for(;;){const auto count=active();budget.check();if(count==0)return;budget.pause();}
    }
};
}
