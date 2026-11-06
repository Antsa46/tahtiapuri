#pragma once
#include "main-bootstrap.h"
#include "../../../packages/windows-runtime/native/common.h"
#include <memory>

namespace mcp_runtime {
// This reader only observes an existing Main-owned control directory. It never
// creates, repairs or grants ACLs, and never supplies a path to the worker.
struct BootstrapLocalMemory { void* value=nullptr; ~BootstrapLocalMemory(){if(value)LocalFree(value);} };
struct BootstrapOwner {
    std::vector<BYTE> tokenUser;BootstrapLocalMemory system;
    BootstrapOwner(){Handle token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value))throw WinError("bootstrap-owner-token");
        tokenUser=tokenInfo(token.value,TokenUser);
        if(!ConvertStringSidToSidW(L"S-1-5-18",&system.value))throw WinError("bootstrap-system-sid");
        if(EqualSid(sid(),system.value))throw WinError("bootstrap-ordinary-owner",ERROR_ACCESS_DENIED);}
    PSID sid()const{return reinterpret_cast<const TOKEN_USER*>(tokenUser.data())->User.Sid;}
};
inline std::wstring bootstrapPath(const std::wstring& path) {
    if(path.size()<4||path.size()>1800||path[0]<L'A'||path[0]>L'Z'||path[1]!=L':'||path[2]!=L'\\'||path.back()==L'\\')
        throw WinError("bootstrap-path",ERROR_INVALID_NAME);
    size_t start=3;
    for(size_t at=3;at<=path.size();++at)if(at==path.size()||path[at]==L'\\') {
        const auto part=path.substr(start,at-start);
        if(part.empty()||part==L"."||part==L".."||part.back()==L'.'||part.back()==L' ')throw WinError("bootstrap-component",ERROR_INVALID_NAME);
        for(wchar_t c:part)if(c<32||c==L'/'||c==L':'||c==L'"'||c==L'<'||c==L'>'||c==L'|'||c==L'?'||c==L'*')
            throw WinError("bootstrap-character",ERROR_INVALID_NAME);
        auto stem=part.substr(0,part.find(L'.'));while(!stem.empty()&&stem.back()==L' ')stem.pop_back();
        for(auto& c:stem)if(c>=L'a'&&c<=L'z')c-=L'a'-L'A';
        const bool port=stem.size()==4&&(stem.compare(0,3,L"COM")==0||stem.compare(0,3,L"LPT")==0)&&
            ((stem[3]>=L'1'&&stem[3]<=L'9')||stem[3]==L'\u00b9'||stem[3]==L'\u00b2'||stem[3]==L'\u00b3');
        if(stem==L"CON"||stem==L"PRN"||stem==L"AUX"||stem==L"NUL"||port)throw WinError("bootstrap-device",ERROR_INVALID_NAME);
        start=at+1;
    }
    // Reject mapped network drives as well as UNC/device namespace spellings.
    if(GetDriveTypeW(path.substr(0,3).c_str())!=DRIVE_FIXED)throw WinError("bootstrap-local-drive",ERROR_INVALID_DRIVE);
    return path;
}
struct BootstrapPin {
    Handle handle;bool directory;std::wstring path;BY_HANDLE_FILE_INFORMATION initial={};
    BootstrapPin(const std::wstring& name,bool dir,DWORD access,DWORD disposition=OPEN_EXISTING):directory(dir),path(name) {
        const auto extended=L"\\\\?\\"+name;
        handle.value=CreateFileW(extended.c_str(),access,dir?FILE_SHARE_READ|FILE_SHARE_WRITE:FILE_SHARE_READ,nullptr,disposition,
            FILE_FLAG_OPEN_REPARSE_POINT|(dir?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr);
        if(handle.value==INVALID_HANDLE_VALUE)throw WinError("bootstrap-open");
        initial=inspect();verifyName();DWORD flags=0;
        if(!GetHandleInformation(handle.value,&flags)||(flags&HANDLE_FLAG_INHERIT))throw WinError("bootstrap-inheritance",ERROR_ACCESS_DENIED);
    }
    BY_HANDLE_FILE_INFORMATION inspect()const {
        BY_HANDLE_FILE_INFORMATION info={};
        if(GetFileType(handle.value)!=FILE_TYPE_DISK||!GetFileInformationByHandle(handle.value,&info))throw WinError("bootstrap-file-info");
        if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory||(!directory&&info.nNumberOfLinks!=1))
            throw WinError("bootstrap-file-type",ERROR_INVALID_DATA);
        return info;
    }
    void verifyName()const {
        std::vector<wchar_t> result(path.size()+16);const DWORD count=GetFinalPathNameByHandleW(handle.value,result.data(),static_cast<DWORD>(result.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
        if(!count||count>=result.size()||std::wstring(result.data())!=L"\\\\?\\"+path)throw WinError("bootstrap-final-name",ERROR_INVALID_NAME);
    }
    void verify()const {
        const auto info=inspect();
        if(info.dwVolumeSerialNumber!=initial.dwVolumeSerialNumber||info.nFileIndexHigh!=initial.nFileIndexHigh||info.nFileIndexLow!=initial.nFileIndexLow)
            throw WinError("bootstrap-file-changed",ERROR_INVALID_DATA);
        verifyName();
    }
};
inline void requireBootstrapAcl(HANDLE file,const BootstrapOwner& owner,bool root) {
    BootstrapLocalMemory memory;PSID actualOwner=nullptr;PACL acl=nullptr;
    const DWORD error=GetSecurityInfo(file,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&actualOwner,nullptr,&acl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&memory.value));
    if(error)throw WinError("bootstrap-security-read",error);
    SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;
    if(!actualOwner||!IsValidSid(actualOwner)||!EqualSid(actualOwner,owner.sid()))throw WinError("bootstrap-file-owner",ERROR_ACCESS_DENIED);
    if(!GetSecurityDescriptorControl(memory.value,&control,&revision)||!(control&SE_DACL_PRESENT)||!acl||!IsValidAcl(acl)||acl->AceCount!=2||bool(control&SE_DACL_PROTECTED)!=root)
        throw WinError("bootstrap-dacl",ERROR_INVALID_ACL);
    bool seenOwner=false,seenSystem=false;const BYTE flags=root?OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE:INHERITED_ACE;
    for(DWORD i=0;i<acl->AceCount;++i){void* raw=nullptr;if(!GetAce(acl,i,&raw))throw WinError("bootstrap-ace-read");
        const auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if(ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE||ace->Header.AceFlags!=flags||ace->Mask!=FILE_ALL_ACCESS||!IsValidSid(&ace->SidStart))
            throw WinError("bootstrap-ace",ERROR_INVALID_ACL);
        if(EqualSid(&ace->SidStart,owner.sid())&&!seenOwner)seenOwner=true;
        else if(EqualSid(&ace->SidStart,owner.system.value)&&!seenSystem)seenSystem=true;
        else throw WinError("bootstrap-ace-principal",ERROR_INVALID_ACL);
    }
    if(!seenOwner||!seenSystem)throw WinError("bootstrap-ace-missing",ERROR_INVALID_ACL);
}

// Pins the existing protected root and every ancestor for readers and publishers.
// Creation of the root remains Main-owned; no code here grants or repairs ACLs.
struct BootstrapDirectoryGuard {
    std::wstring path,root;
    BootstrapOwner owner;
    std::vector<std::unique_ptr<BootstrapPin>> ancestors;
    std::unique_ptr<BootstrapPin> directory;
    explicit BootstrapDirectoryGuard(const std::wstring& supplied):path(bootstrapPath(supplied)) {
        const auto leaf=path.find_last_of(L'\\');
        if(leaf<=3||path.substr(leaf+1)!=L"main-bootstrap.bin")throw WinError("bootstrap-fixed-leaf",ERROR_INVALID_NAME);
        root=path.substr(0,leaf);
        ancestors.push_back(std::make_unique<BootstrapPin>(path.substr(0,3),true,FILE_READ_ATTRIBUTES));
        for(size_t at=3;(at=root.find(L'\\',at))!=std::wstring::npos;++at)
            ancestors.push_back(std::make_unique<BootstrapPin>(root.substr(0,at),true,FILE_READ_ATTRIBUTES));
        directory=std::make_unique<BootstrapPin>(root,true,READ_CONTROL|FILE_READ_ATTRIBUTES);
        verify();
    }
    void verify()const {
        for(const auto& ancestor:ancestors)ancestor->verify();
        directory->verify();requireBootstrapAcl(directory->handle.value,owner,true);
    }
};
inline std::array<uint8_t,bootstrapBytes> readBootstrapBytes(BootstrapPin& file,const BootstrapOwner& owner) {
    requireBootstrapAcl(file.handle.value,owner,false);
    const auto info=file.inspect();if(info.nFileSizeHigh||info.nFileSizeLow!=bootstrapBytes)throw WinError("bootstrap-size",ERROR_INVALID_DATA);
    LARGE_INTEGER zero={};if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN))throw WinError("bootstrap-read-position");
    std::array<uint8_t,bootstrapBytes> bytes={};DWORD count=0;
    if(!ReadFile(file.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)||count!=bytes.size())throw WinError("bootstrap-read");
    file.verify();requireBootstrapAcl(file.handle.value,owner,false);return bytes;
}
inline MainBootstrap readMainBootstrapFile(const std::wstring& supplied) {
    BootstrapDirectoryGuard guard(supplied);
    BootstrapPin file(guard.path,false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES);
    auto bytes=readBootstrapBytes(file,guard.owner);guard.verify();
    const auto value=decodeMainBootstrap(bytes.data(),bytes.size());SecureZeroMemory(bytes.data(),bytes.size());
    // No handles escape. Main may consume/unlink immediately after authentication.
    return value;
}
}
