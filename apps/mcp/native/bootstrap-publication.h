#pragma once
#include "bootstrap-file.h"
#include <cstring>

namespace mcp_runtime {
inline void closeBootstrapHandle(BootstrapPin& file) {
    const HANDLE raw=file.handle.value;file.handle.value=nullptr;
    if(!CloseHandle(raw))throw WinError("bootstrap-close");
}
inline void requireBootstrapAbsent(const std::wstring& path) {
    const DWORD attributes=GetFileAttributesW((L"\\\\?\\"+path).c_str());
    if(attributes!=INVALID_FILE_ATTRIBUTES)throw WinError("bootstrap-still-present",ERROR_ALREADY_EXISTS);
    if(GetLastError()!=ERROR_FILE_NOT_FOUND)throw WinError("bootstrap-absence-uncertain");
}
inline void removeBootstrapPin(BootstrapPin& file,BootstrapDirectoryGuard& guard) {
    guard.verify();file.verify();requireBootstrapAcl(file.handle.value,guard.owner,false);
    FILE_DISPOSITION_INFO info={TRUE};
    if(!SetFileInformationByHandle(file.handle.value,FileDispositionInfo,&info,sizeof(info)))throw WinError("bootstrap-delete");
    const auto path=file.path;closeBootstrapHandle(file);
    guard.verify();requireBootstrapAbsent(path);
}
struct BootstrapMainState {
    Handle process;
    bool live=false;
    explicit BootstrapMainState(const MainIdentity& expected) {
        process.value=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,expected.pid);
        if(!process.value) {
            const DWORD error=GetLastError();
            if(error==ERROR_INVALID_PARAMETER)return; // A specifically absent PID, not generic query failure.
            throw WinError("bootstrap-main-open",error);
        }
        FILETIME creation={},exit={},kernel={},user={};
        if(GetProcessId(process.value)!=expected.pid||!GetProcessTimes(process.value,&creation,&exit,&kernel,&user))
            throw WinError("bootstrap-main-times");
        const DWORD wait=WaitForSingleObject(process.value,0);
        if(wait!=WAIT_TIMEOUT&&wait!=WAIT_OBJECT_0)throw WinError("bootstrap-main-wait");
        const uint64_t time=(uint64_t(creation.dwHighDateTime)<<32)|creation.dwLowDateTime;
        live=wait==WAIT_TIMEOUT&&time==expected.creationTime;
    }
};
inline void requirePublishingMain(const MainBootstrap& value) {
    BootstrapMainState state(value.main);
    if(!state.live)throw WinError("bootstrap-main-not-live",ERROR_PROCESS_ABORTED);
}
inline void publishMainBootstrap(const std::wstring& supplied,const std::array<uint8_t,bootstrapBytes>& bytes) {
    const auto value=decodeMainBootstrap(bytes.data(),bytes.size());requirePublishingMain(value);
    BootstrapDirectoryGuard guard(supplied);
    const auto pending=guard.root+L"\\main-bootstrap.pending";
    BootstrapPin file(pending,false,GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES,CREATE_NEW);
    bool renamed=false;
    try {
        guard.verify();requireBootstrapAcl(file.handle.value,guard.owner,false);
        DWORD written=0;
        if(!WriteFile(file.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)||written!=bytes.size())
            throw WinError("bootstrap-write");
        if(!FlushFileBuffers(file.handle.value))throw WinError("bootstrap-flush");
        if(readBootstrapBytes(file,guard.owner)!=bytes)throw WinError("bootstrap-written-bytes",ERROR_INVALID_DATA);
        guard.verify();requirePublishingMain(value);
        // Win32 rejected the relative RootDirectory form with ERROR_INVALID_PARAMETER
        // in the actual target runtime. The documented absolute form keeps the
        // same retained ancestor/root pins; it does not reopen or replace paths.
        const std::wstring leaf=L"\\\\?\\"+guard.path;
        std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO)+leaf.size()*sizeof(wchar_t));
        auto* rename=reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
        rename->ReplaceIfExists=FALSE;rename->RootDirectory=nullptr;
        rename->FileNameLength=static_cast<DWORD>(leaf.size()*sizeof(wchar_t));
        memcpy(rename->FileName,leaf.c_str(),(leaf.size()+1)*sizeof(wchar_t));
        if(!SetFileInformationByHandle(file.handle.value,FileRenameInfo,rename,static_cast<DWORD>(storage.size())))
            throw WinError("bootstrap-publish-rename");
        renamed=true;file.path=guard.path;
        if(readBootstrapBytes(file,guard.owner)!=bytes)throw WinError("bootstrap-published-bytes",ERROR_INVALID_DATA);
        guard.verify();closeBootstrapHandle(file);
    } catch (...) {
        // Only our still-open unpublished scratch may be rolled back. An
        // ambiguous post-rename outcome is preserved for explicit recovery.
        if(!renamed&&file.handle.value&&file.handle.value!=INVALID_HANDLE_VALUE) {
            FILE_DISPOSITION_INFO remove={TRUE};
            (void)SetFileInformationByHandle(file.handle.value,FileDispositionInfo,&remove,sizeof(remove));
        }
        throw;
    }
}
inline void consumeMainBootstrap(const std::wstring& supplied,const std::array<uint8_t,bootstrapBytes>& expected) {
    (void)decodeMainBootstrap(expected.data(),expected.size());
    BootstrapDirectoryGuard guard(supplied);
    BootstrapPin file(guard.path,false,GENERIC_READ|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES);
    auto bytes=readBootstrapBytes(file,guard.owner);guard.verify();
    if(bytes!=expected)throw WinError("bootstrap-wrong-generation",ERROR_ACCESS_DENIED);
    removeBootstrapPin(file,guard);SecureZeroMemory(bytes.data(),bytes.size());
}
inline std::unique_ptr<BootstrapPin> optionalBootstrapPin(const std::wstring& path) {
    try{return std::make_unique<BootstrapPin>(path,false,GENERIC_READ|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES);}
    catch(const WinError& error){if(error.code==ERROR_FILE_NOT_FOUND)return {};throw;}
}

// Reserved scratch may be incomplete, but known header bytes must still match.
// A complete identity is checked even when the remaining token was never written.
inline std::unique_ptr<BootstrapMainState> validatePendingBootstrap(BootstrapPin& file,const BootstrapOwner& owner) {
    requireBootstrapAcl(file.handle.value,owner,false);
    const auto info=file.inspect();
    if(info.nFileSizeHigh||info.nFileSizeLow>bootstrapBytes)throw WinError("bootstrap-pending-size",ERROR_INVALID_DATA);
    std::array<uint8_t,bootstrapBytes> bytes={};DWORD count=0;
    if(!ReadFile(file.handle.value,bytes.data(),info.nFileSizeLow,&count,nullptr)||count!=info.nFileSizeLow)
        throw WinError("bootstrap-pending-read");
    constexpr uint8_t header[16]={'T','M','B','O','O','T','1',0,1,0,0,0,96,0,0,0};
    for(size_t i=0;i<std::min<size_t>(count,16);++i)if(bytes[i]!=header[i])throw WinError("bootstrap-pending-format",ERROR_INVALID_DATA);
    for(size_t i=20;i<std::min<size_t>(count,24);++i)if(bytes[i])throw WinError("bootstrap-pending-format",ERROR_INVALID_DATA);
    std::unique_ptr<BootstrapMainState> state;
    if(count>=32) {
        const MainIdentity identity={bootstrap32(bytes.data()+16),bootstrap64(bytes.data()+24)};
        if(!identity.pid||!identity.creationTime)throw WinError("bootstrap-pending-identity",ERROR_INVALID_DATA);
        state=std::make_unique<BootstrapMainState>(identity);
        if(state->live)throw WinError("bootstrap-pending-main-live",ERROR_BUSY);
    }
    if(count==bootstrapBytes)(void)decodeMainBootstrap(bytes.data(),bytes.size());
    file.verify();requireBootstrapAcl(file.handle.value,owner,false);SecureZeroMemory(bytes.data(),bytes.size());return state;
}
/** Startup-only descriptor maintenance under Main's single-instance lock and
 * serialized helper calls. This says nothing about surviving broker/worker Jobs. */
inline void recoverMainBootstrap(const std::wstring& supplied) {
    BootstrapDirectoryGuard guard(supplied);
    auto pending=optionalBootstrapPin(guard.root+L"\\main-bootstrap.pending");
    std::unique_ptr<BootstrapMainState> pendingState;
    if(pending)pendingState=validatePendingBootstrap(*pending,guard.owner);
    auto file=optionalBootstrapPin(guard.path);
    std::unique_ptr<BootstrapMainState> state;
    if(file) {
        auto bytes=readBootstrapBytes(*file,guard.owner);
        const auto value=decodeMainBootstrap(bytes.data(),bytes.size());SecureZeroMemory(bytes.data(),bytes.size());
        state=std::make_unique<BootstrapMainState>(value.main);
        if(state->live)throw WinError("bootstrap-main-live",ERROR_BUSY);
    }
    guard.verify();
    if(file)removeBootstrapPin(*file,guard);
    if(pending)removeBootstrapPin(*pending,guard);
    guard.verify();requireBootstrapAbsent(guard.path);requireBootstrapAbsent(guard.root+L"\\main-bootstrap.pending");
}
}
