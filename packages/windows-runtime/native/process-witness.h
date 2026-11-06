#pragma once
#include "common.h"
#include <cstdint>
#include <tlhelp32.h>

namespace windows_runtime {
// This is an owning native API seam, never a runtime flag or worker command.
// Recovery requests no rights capable of terminating an unrelated process.
struct ProcessWitnessApi {
    virtual ~ProcessWitnessApi()=default;
    virtual uint64_t tick(){return GetTickCount64();}
    virtual HANDLE openProcess(DWORD pid){return OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);}
    virtual uint64_t creationTime(HANDLE process){
        FILETIME creation={},exit={},kernel={},user={};
        if(!GetProcessTimes(process,&creation,&exit,&kernel,&user))throw WinError("process-creation-time");
        return (uint64_t(creation.dwHighDateTime)<<32)|creation.dwLowDateTime;
    }
    virtual DWORD wait(HANDLE process,DWORD milliseconds){return WaitForSingleObject(process,milliseconds);}
    virtual HANDLE snapshot(){return CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);}
    virtual bool first(HANDLE snapshot,DWORD& pid){
        PROCESSENTRY32W entry={};entry.dwSize=sizeof(entry);
        if(!Process32FirstW(snapshot,&entry))throw WinError("process-snapshot-first");
        pid=entry.th32ProcessID;return true;
    }
    virtual bool next(HANDLE snapshot,DWORD& pid){
        PROCESSENTRY32W entry={};entry.dwSize=sizeof(entry);
        if(Process32NextW(snapshot,&entry)){pid=entry.th32ProcessID;return true;}
        DWORD error=GetLastError();if(error!=ERROR_NO_MORE_FILES)throw WinError("process-snapshot-next",error);return false;
    }
    virtual DWORD ownPid(){return GetCurrentProcessId();}
    virtual void close(HANDLE handle){CloseHandle(handle);}
    virtual void pause(DWORD milliseconds){Sleep(milliseconds);}
};
inline ProcessWitnessApi& windowsProcessWitnessApi(){static ProcessWitnessApi api;return api;}
class TerminationBudget {
    ProcessWitnessApi& api;uint64_t end;
public:
    explicit TerminationBudget(ProcessWitnessApi& native):api(native),end(native.tick()+5000){}
    uint64_t deadline() const{return end;}
    void check(){if(api.tick()>=end)throw WinError("termination-deadline",ERROR_TIMEOUT);}
    DWORD remaining(){check();auto t=api.tick();if(t>=end)throw WinError("termination-deadline",ERROR_TIMEOUT);return static_cast<DWORD>(end-t);}
    void pause(){check();api.pause(std::min<DWORD>(10,remaining()));check();}
};
struct WitnessHandle {
    ProcessWitnessApi& api;HANDLE value;
    WitnessHandle(ProcessWitnessApi& native,HANDLE handle):api(native),value(handle){}
    ~WitnessHandle(){if(value&&value!=INVALID_HANDLE_VALUE)api.close(value);}
    WitnessHandle(const WitnessHandle&)=delete;WitnessHandle& operator=(const WitnessHandle&)=delete;
};
inline void proveRecordedProcessExit(ProcessWitnessApi& api,TerminationBudget& budget,DWORD pid,uint64_t creation) {
    budget.check();WitnessHandle process(api,api.openProcess(pid));budget.check();
    if(process.value&&process.value!=INVALID_HANDLE_VALUE){
        auto actual=api.creationTime(process.value);budget.check();
        if(actual!=creation)throw WinError("process-identity-mismatch",ERROR_INVALID_DATA);
        const auto result=api.wait(process.value,budget.remaining());budget.check();
        if(result!=WAIT_OBJECT_0)throw WinError("process-exit-unproven",result==WAIT_TIMEOUT?ERROR_TIMEOUT:ERROR_INVALID_STATE);
        return;
    }
    // No OpenProcess error code is an absence proof. Exactly one complete
    // process-only snapshot is the sole fallback, including our own PID.
    WitnessHandle snapshot(api,api.snapshot());budget.check();
    if(!snapshot.value||snapshot.value==INVALID_HANDLE_VALUE)throw WinError("process-snapshot");
    DWORD pidInSnapshot=0;const auto own=api.ownPid();budget.check();bool self=false,recorded=false;
    if(!api.first(snapshot.value,pidInSnapshot))throw WinError("process-snapshot-empty",ERROR_INVALID_DATA);
    budget.check();
    for(;;){
        self|=pidInSnapshot==own;recorded|=pidInSnapshot==pid;
        const bool more=api.next(snapshot.value,pidInSnapshot);budget.check();if(!more)break;
    }
    if(!self||recorded)throw WinError("process-snapshot-unproven",ERROR_INVALID_DATA);
}
}
