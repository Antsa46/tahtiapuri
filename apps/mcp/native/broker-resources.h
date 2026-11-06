#pragma once
#include "bootstrap-file.h"
#include "mcp-runtime-pins.h"
#include "broker-wire.h"
#include "../../../packages/windows-runtime/native/owner-security.h"
#include <bcrypt.h>
#include <set>
#pragma comment(lib,"bcrypt.lib")
#pragma comment(lib,"advapi32.lib")
#pragma comment(lib,"userenv.lib")

namespace mcp_runtime {
inline std::wstring extended(const std::wstring& path){return L"\\\\?\\"+path;}
inline std::wstring hex(const uint8_t* bytes,size_t size){std::wstring result;for(size_t i=0;i<size;++i){result+=L"0123456789abcdef"[bytes[i]>>4];result+=L"0123456789abcdef"[bytes[i]&15];}return result;}
inline void put64(uint8_t* p,uint64_t value){for(unsigned i=0;i<8;++i)p[i]=uint8_t(value>>(8*i));}
inline std::vector<std::wstring> children(const std::wstring& path,size_t maximum){
    WIN32_FIND_DATAW data={};HANDLE search=FindFirstFileW((extended(path)+L"\\*").c_str(),&data);
    if(search==INVALID_HANDLE_VALUE)throw WinError("mcp-tree-enumerate");std::vector<std::wstring> result;
    do{std::wstring name=data.cFileName;if(name!=L"."&&name!=L".."){if(result.size()>=maximum){FindClose(search);throw WinError("mcp-tree-bound",ERROR_BUFFER_OVERFLOW);}result.push_back(name);}}while(FindNextFileW(search,&data));
    const DWORD error=GetLastError();FindClose(search);if(error!=ERROR_NO_MORE_FILES)throw WinError("mcp-tree-enumerate",error);
    std::sort(result.begin(),result.end());return result;
}
inline void exactChildren(const std::wstring& path,std::vector<std::wstring> expected){std::sort(expected.begin(),expected.end());if(children(path,expected.size()+1)!=expected)throw WinError("mcp-tree-shape",ERROR_INVALID_DATA);}
inline void resourceAcl(const BootstrapPin& pin,const BootstrapOwner& owner,PSID worker,DWORD rights,bool inherit,bool apply,bool inherited=false){
    pin.verify();windows_runtime::LocalMemory prior;PSID actualOwner=nullptr;
    DWORD error=GetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&actualOwner,nullptr,nullptr,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&prior.value));
    if(error||!actualOwner||!EqualSid(actualOwner,owner.sid()))throw WinError("mcp-resource-owner",error?error:ERROR_ACCESS_DENIED);
    if(apply){
        EXPLICIT_ACCESSW rules[3]={};const DWORD count=worker?3:2;
        for(DWORD i=0;i<count;++i){rules[i].grfAccessMode=SET_ACCESS;rules[i].grfInheritance=inherit?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;rules[i].Trustee.TrusteeForm=TRUSTEE_IS_SID;}
        rules[0].grfAccessPermissions=FILE_ALL_ACCESS;rules[0].Trustee.ptstrName=reinterpret_cast<LPWSTR>(owner.sid());
        rules[1].grfAccessPermissions=FILE_ALL_ACCESS;rules[1].Trustee.ptstrName=reinterpret_cast<LPWSTR>(owner.system.value);
        if(worker){rules[2].grfAccessPermissions=rights;rules[2].Trustee.ptstrName=reinterpret_cast<LPWSTR>(worker);}
        windows_runtime::LocalMemory acl;error=SetEntriesInAclW(count,rules,nullptr,reinterpret_cast<PACL*>(&acl.value));if(error)throw WinError("mcp-acl-create",error);
        error=SetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,static_cast<PACL>(acl.value),nullptr);if(error)throw WinError("mcp-acl-set",error);
    }
    windows_runtime::LocalMemory memory;PACL acl=nullptr;actualOwner=nullptr;
    error=GetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&actualOwner,nullptr,&acl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&memory.value));
    SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;
    if(error||!actualOwner||!EqualSid(actualOwner,owner.sid())||!GetSecurityDescriptorControl(memory.value,&control,&revision)||bool(control&SE_DACL_PROTECTED)==inherited||!acl||!IsValidAcl(acl)||acl->AceCount!=(worker?3:2))throw WinError("mcp-acl-policy",error?error:ERROR_INVALID_ACL);
    const BYTE flags=BYTE((inherit?(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE):0)|(inherited?INHERITED_ACE:0));bool user=false,system=false,package=false;
    for(DWORD i=0;i<acl->AceCount;++i){void* raw=nullptr;if(!GetAce(acl,i,&raw))throw WinError("mcp-acl-ace");auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if(ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE||ace->Header.AceFlags!=flags||!IsValidSid(&ace->SidStart))throw WinError("mcp-acl-flags",ERROR_INVALID_ACL);
        if(EqualSid(&ace->SidStart,owner.sid())&&!user&&ace->Mask==FILE_ALL_ACCESS)user=true;
        else if(EqualSid(&ace->SidStart,owner.system.value)&&!system&&ace->Mask==FILE_ALL_ACCESS)system=true;
        else if(worker&&EqualSid(&ace->SidStart,worker)&&!package&&ace->Mask==rights)package=true;
        else throw WinError("mcp-acl-principal",ERROR_INVALID_ACL);
    }
    if(!user||!system||(worker&&!package))throw WinError("mcp-acl-missing",ERROR_INVALID_ACL);
}
inline std::string fileDigest(BootstrapPin& file,uint64_t expected){
    const auto info=file.inspect();if((uint64_t(info.nFileSizeHigh)<<32|info.nFileSizeLow)!=expected||expected>128ULL*1024*1024)throw WinError("mcp-pin-size",ERROR_INVALID_DATA);
    LARGE_INTEGER zero={};if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN))throw WinError("mcp-pin-rewind");
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<uint8_t,32> digest={};
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("mcp-sha-open");
    try{
        if(BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)<0)throw WinError("mcp-sha-create");std::array<uint8_t,65536> buffer={};uint64_t total=0;
        for(;;){DWORD got=0;if(!ReadFile(file.handle.value,buffer.data(),static_cast<DWORD>(buffer.size()),&got,nullptr))throw WinError("mcp-pin-read");if(!got)break;
            total+=got;if(total>expected||BCryptHashData(hash,buffer.data(),got,0)<0)throw WinError("mcp-sha-update");}
        if(total!=expected||BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0)<0)throw WinError("mcp-sha-finish");
    }catch(...){if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);throw;}
    BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);file.verify();std::string text;for(uint8_t byte:digest){text+="0123456789abcdef"[byte>>4];text+="0123456789abcdef"[byte&15];}return text;
}
inline void lowScratch(BootstrapPin& scratch){
    windows_runtime::LocalMemory descriptor;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)",SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value),nullptr))throw WinError("mcp-label-create");
    PACL acl=nullptr;BOOL present=FALSE,defaulted=FALSE;if(!GetSecurityDescriptorSacl(descriptor.value,&present,&acl,&defaulted)||!present)throw WinError("mcp-label-source");
    DWORD error=SetSecurityInfo(scratch.handle.value,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,acl);if(error)throw WinError("mcp-label-set",error);
    windows_runtime::LocalMemory readback;error=GetSecurityInfo(scratch.handle.value,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,&acl,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&readback.value));
    if(error||!acl||acl->AceCount!=1)throw WinError("mcp-label-readback",error?error:ERROR_INVALID_ACL);
    void* raw=nullptr;if(!GetAce(acl,0,&raw))throw WinError("mcp-label-ace");auto ace=static_cast<SYSTEM_MANDATORY_LABEL_ACE*>(raw);PSID sid=&ace->SidStart;
    if(ace->Header.AceType!=SYSTEM_MANDATORY_LABEL_ACE_TYPE||ace->Header.AceFlags!=(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE)||ace->Mask!=SYSTEM_MANDATORY_LABEL_NO_WRITE_UP||!IsValidSid(sid)||*GetSidSubAuthorityCount(sid)!=1||*GetSidSubAuthority(sid,0)!=SECURITY_MANDATORY_LOW_RID)throw WinError("mcp-label-policy",ERROR_INVALID_ACL);
}
class BrokerResources {
    BootstrapDirectoryGuard& control;
    std::vector<std::unique_ptr<BootstrapPin>> packagePins;
    std::unique_ptr<BootstrapPin> stagePin,scratchPin;
    static constexpr DWORD access=READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES;
    static constexpr DWORD workerRead=FILE_GENERIC_READ|FILE_GENERIC_EXECUTE;
public:
    const std::wstring reservation,stage,package,scratch,node,entry;
    std::unique_ptr<BootstrapPin> reservationPin;
    explicit BrokerResources(BootstrapDirectoryGuard& guard):control(guard),reservation(guard.root+L"\\native-session-reserved"),stage(reservation+L"\\worker"),package(stage+L"\\package"),scratch(stage+L"\\scratch"),node(package+L"\\node.exe"),entry(package+L"\\mcp-worker.mjs"){
        if(package.size()>258||node.size()>259)throw WinError("mcp-process-path-length",ERROR_FILENAME_EXCED_RANGE);
        control.verify();reservationPin=std::make_unique<BootstrapPin>(reservation,true,access);
        resourceAcl(*reservationPin,control.owner,nullptr,0,true,false,true);exactChildren(reservation,{L"worker"});
        stagePin=std::make_unique<BootstrapPin>(stage,true,access);scratchPin=std::make_unique<BootstrapPin>(scratch,true,access);
        resourceAcl(*stagePin,control.owner,nullptr,0,true,false,true);resourceAcl(*scratchPin,control.owner,nullptr,0,true,false,true);
        exactChildren(stage,{L"package",L"scratch"});exactChildren(scratch,{});
        // Fixed compiled package only, never arbitrary manifest-selected paths.
        const std::set<std::wstring> required={L"licenses/mcp-core-LICENSE.txt",L"licenses/mcp-server-LICENSE.txt",L"licenses/node-LICENSE.txt",L"licenses/zod-LICENSE.txt",L"mcp-worker.mjs",L"node.exe",L"package.json",L"runtime-manifest.json"};
        std::set<std::wstring> seen;
        for(const auto& item:runtimePins)if(!required.count(item.path)||!seen.insert(item.path).second)throw WinError("mcp-compiled-pin-set",ERROR_INVALID_DATA);
        if(seen!=required)throw WinError("mcp-compiled-pins-missing",ERROR_INVALID_DATA);
        for(const auto& path:{package,package+L"\\licenses"}){
            auto pin=std::make_unique<BootstrapPin>(path,true,access);resourceAcl(*pin,control.owner,nullptr,0,true,false,true);packagePins.push_back(std::move(pin));
        }
        exactChildren(package,{L"licenses",L"mcp-worker.mjs",L"node.exe",L"package.json",L"runtime-manifest.json"});
        exactChildren(package+L"\\licenses",{L"mcp-core-LICENSE.txt",L"mcp-server-LICENSE.txt",L"node-LICENSE.txt",L"zod-LICENSE.txt"});
        for(const auto& item:runtimePins){std::wstring relative=item.path;std::replace(relative.begin(),relative.end(),L'/',L'\\');
            auto pin=std::make_unique<BootstrapPin>(package+L"\\"+relative,false,GENERIC_READ|access);resourceAcl(*pin,control.owner,nullptr,0,false,false,true);
            const auto digest=fileDigest(*pin,item.bytes);if(digest!=item.sha256||(relative==L"runtime-manifest.json"&&digest!=runtimePackageDigest))throw WinError("mcp-package-hash",ERROR_INVALID_DATA);
            packagePins.push_back(std::move(pin));
        }
    }
    const BY_HANDLE_FILE_INFORMATION& identity()const{return stagePin->initial;}
    void grant(PSID sid){
        control.verify();reservationPin->verify();stagePin->verify();scratchPin->verify();for(const auto& pin:packagePins)pin->verify();
        // Seal before adding worker access; every file pin denies write/delete.
        for(auto i=packagePins.rbegin();i!=packagePins.rend();++i)resourceAcl(**i,control.owner,nullptr,0,false,true);
        resourceAcl(*stagePin,control.owner,nullptr,0,false,true);resourceAcl(*scratchPin,control.owner,nullptr,0,false,true);
        exactChildren(reservation,{L"broker-journal.bin",L"worker"});exactChildren(stage,{L"package",L"scratch"});exactChildren(scratch,{});
        exactChildren(package,{L"licenses",L"mcp-worker.mjs",L"node.exe",L"package.json",L"runtime-manifest.json"});
        exactChildren(package+L"\\licenses",{L"mcp-core-LICENSE.txt",L"mcp-server-LICENSE.txt",L"node-LICENSE.txt",L"zod-LICENSE.txt"});
        for(auto i=packagePins.rbegin();i!=packagePins.rend();++i)resourceAcl(**i,control.owner,sid,workerRead,false,true);
        resourceAcl(*stagePin,control.owner,sid,workerRead,false,true);
        resourceAcl(*scratchPin,control.owner,sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE|DELETE|FILE_DELETE_CHILD,true,true);lowScratch(*scratchPin);
    }
    // Caller MUST have independently observed process exit and authenticated Job0.
    void removeAfterExit(){
        control.verify();reservationPin->verify();stagePin->verify();const auto expected=stagePin->initial;
        resourceAcl(*stagePin,control.owner,nullptr,0,false,true);
        packagePins.clear();scratchPin.reset();stagePin.reset();size_t nodes=0;
        std::function<void(const std::wstring&,unsigned)> remove=[&](const std::wstring& path,unsigned depth){
            if(depth>16||++nodes>4096)throw WinError("mcp-cleanup-bound",ERROR_BUFFER_OVERFLOW);
            const DWORD attrs=GetFileAttributesW(extended(path).c_str());if(attrs==INVALID_FILE_ATTRIBUTES)throw WinError("mcp-cleanup-attributes");
            const bool directory=(attrs&FILE_ATTRIBUTE_DIRECTORY)!=0;
            {BootstrapPin pin(path,directory,access);windows_runtime::LocalMemory memory;PSID owner=nullptr;
                DWORD error=GetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,nullptr,nullptr,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&memory.value));
                if(error||!owner||!EqualSid(owner,control.owner.sid()))throw WinError("mcp-cleanup-owner",ERROR_ACCESS_DENIED);
                if(path==stage&&(pin.initial.dwVolumeSerialNumber!=expected.dwVolumeSerialNumber||pin.initial.nFileIndexHigh!=expected.nFileIndexHigh||pin.initial.nFileIndexLow!=expected.nFileIndexLow))throw WinError("mcp-cleanup-stage-identity",ERROR_INVALID_DATA);
                if(directory)for(const auto& child:children(path,4096))remove(path+L"\\"+child,depth+1);pin.verify();
            }
            if(!(directory?RemoveDirectoryW(extended(path).c_str()):DeleteFileW(extended(path).c_str())))throw WinError("mcp-cleanup-remove");
        };
        remove(stage,0);const DWORD attrs=GetFileAttributesW(extended(stage).c_str());if(attrs!=INVALID_FILE_ATTRIBUTES||GetLastError()!=ERROR_FILE_NOT_FOUND)throw WinError("mcp-cleanup-absence",ERROR_INVALID_DATA);
        exactChildren(reservation,{L"broker-journal.bin"});
    }
};
}
