#pragma once
#include "../../../packages/windows-runtime/native/common.h"
#include "main-bootstrap.h"

namespace mcp_runtime {
inline MainIdentity queryMainIdentity(HANDLE process) {
    DWORD pid=GetProcessId(process);FILETIME creation={},exit={},kernel={},user={};
    if(!pid||!GetProcessTimes(process,&creation,&exit,&kernel,&user))throw WinError("main-process-times");
    if(WaitForSingleObject(process,0)!=WAIT_TIMEOUT)throw WinError("main-not-live",ERROR_PROCESS_ABORTED);
    return {pid,(uint64_t(creation.dwHighDateTime)<<32)|creation.dwLowDateTime};
}
// Construction never writes a byte. Only a successfully verified object exposes
// the channel for the later bounded handshake. The retained process handle binds
// lifetime and prevents PID reuse from becoming an accepted peer identity.
class VerifiedMainPipe {
    Handle pipe_,main_;
    MainIdentity expected_;
public:
    explicit VerifiedMainPipe(const MainBootstrap& bootstrap):expected_(bootstrap.main) {
        if(!expected_.pid||!expected_.creationTime)throw WinError("main-identity-empty",ERROR_INVALID_DATA);
        const auto name=mainPipeName(bootstrap);
        pipe_.value=CreateFileW(name.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr);
        if(pipe_.value==INVALID_HANDLE_VALUE)throw WinError("main-pipe-open");
        ULONG actual=0;
        if(!GetNamedPipeServerProcessId(pipe_.value,&actual))throw WinError("main-pipe-server-id");
        if(actual!=expected_.pid)throw WinError("main-pipe-wrong-server",ERROR_ACCESS_DENIED);
        main_.value=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,actual);
        if(!main_.value)throw WinError("main-process-open");
        verify();
        for(HANDLE handle:{pipe_.value,main_.value}) {
            DWORD flags=0;if(!GetHandleInformation(handle,&flags)||(flags&HANDLE_FLAG_INHERIT))throw WinError("main-handle-inheritance",ERROR_ACCESS_DENIED);
        }
    }
    void verify() const {
        ULONG server=0;if(!GetNamedPipeServerProcessId(pipe_.value,&server))throw WinError("main-pipe-recheck");
        const auto identity=queryMainIdentity(main_.value);
        if(server!=expected_.pid||identity.pid!=expected_.pid||identity.creationTime!=expected_.creationTime)
            throw WinError("main-identity-mismatch",ERROR_ACCESS_DENIED);
    }
    HANDLE channel() const { verify();return pipe_.value; }
    HANDLE lifetime() const { return main_.value; }
};
}
