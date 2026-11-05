#pragma once
#include "backend-wire.h"
#include <bcrypt.h>
#include <set>
#pragma comment(lib,"bcrypt.lib")
#pragma comment(lib,"userenv.lib")
#pragma comment(lib,"advapi32.lib")
namespace backend_runtime {
struct LocalMemory { void* value=nullptr;~LocalMemory(){if(value)LocalFree(value);} };
inline std::wstring sidText(PSID sid) {
    LocalMemory memory; if(!IsValidSid(sid)||!ConvertSidToStringSidW(sid,reinterpret_cast<LPWSTR*>(&memory.value)))throw WinError("sid-text");
    return static_cast<LPWSTR>(memory.value);
}
struct Owner {
    std::vector<BYTE> user; LocalMemory system;std::wstring text;
    Owner(){Handle token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value))throw WinError("owner-token");user=tokenInfo(token.value,TokenUser);text=sidText(sid());
        if(!ConvertStringSidToSidW(L"S-1-5-18",&system.value))throw WinError("system-sid");}
    PSID sid() const{return reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;}
};
inline std::wstring canonicalPath(const std::wstring& value) {
    if(value.size()<4||value.size()>1800||value[0]<L'A'||value[0]>L'Z'||value[1]!=L':'||value[2]!=L'\\'||value.back()==L'\\'||
        value.find(L'/',3)!=std::wstring::npos||value.find(L':',2)!=std::wstring::npos||value.find(L'\0')!=std::wstring::npos)
        throw WinError("normal-dos-path",ERROR_INVALID_NAME);
    size_t begin=3;
    for(size_t at=3;at<=value.size();++at)if(at==value.size()||value[at]==L'\\') {
        auto part=value.substr(begin,at-begin);if(part.empty()||part==L"."||part==L".."||part.back()==L'.'||part.back()==L' ')throw WinError("path-component",ERROR_INVALID_NAME);
        for(wchar_t c:part)if(c<32||c==L'"'||c==L'<'||c==L'>'||c==L'|'||c==L'?'||c==L'*')throw WinError("path-character",ERROR_INVALID_NAME);
        // Win32 device names remain reserved with an extension (including the
        // ISO-8859-1 superscript digits recognized for COM/LPT devices).
        auto stem=part.substr(0,part.find(L'.'));while(!stem.empty()&&stem.back()==L' ')stem.pop_back();
        for(auto& c:stem)if(c>=L'a'&&c<=L'z')c-=L'a'-L'A';
        const bool port=stem.size()==4&&(stem.compare(0,3,L"COM")==0||stem.compare(0,3,L"LPT")==0)&&
            ((stem[3]>=L'1'&&stem[3]<=L'9')||stem[3]==L'\u00b9'||stem[3]==L'\u00b2'||stem[3]==L'\u00b3');
        if(stem==L"CON"||stem==L"PRN"||stem==L"AUX"||stem==L"NUL"||port)throw WinError("path-device-name",ERROR_INVALID_NAME);
        begin=at+1;
    }
    // Only the validated internal spelling reaches Win32's extended namespace.
    // Verification must itself work beyond MAX_PATH without a system opt-in.
    const auto extended=L"\\\\?\\"+value;
    std::vector<wchar_t> full(extended.size()+16);DWORD size=GetFullPathNameW(extended.c_str(),static_cast<DWORD>(full.size()),full.data(),nullptr);
    if(!size||size>=full.size()||extended!=full.data())throw WinError("path-canonical",ERROR_INVALID_NAME);return value;
}
inline std::wstring filesystemPath(const std::wstring& value) {
    // Ancestor pinning alone needs a drive root, which canonicalPath excludes.
    const bool root=value.size()==3&&value[0]>=L'A'&&value[0]<=L'Z'&&value[1]==L':'&&value[2]==L'\\';
    return L"\\\\?\\"+(root?value:canonicalPath(value));
}
inline void requireProcessPaths(const std::wstring& cwd,const std::wstring& executable) {
    canonicalPath(cwd);canonicalPath(executable);
    // Normal DOS paths stay in CreateProcessW. Cwd also needs room for a
    // trailing slash plus NUL; the executable needs room for its NUL.
    if(cwd.size()>258||executable.size()>259)throw WinError("process-path-length",ERROR_FILENAME_EXCED_RANGE);
}
struct Identity { DWORD volume=0,high=0,low=0;bool operator==(const Identity& other)const{return volume==other.volume&&high==other.high&&low==other.low;} };
inline Identity identity(HANDLE handle,bool directory) {
    BY_HANDLE_FILE_INFORMATION info={};if(!GetFileInformationByHandle(handle,&info)||
        (info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory||(!directory&&info.nNumberOfLinks!=1))
        throw WinError("file-identity",ERROR_INVALID_DATA);
    return {info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow};
}
inline void finalName(HANDLE handle,const std::wstring& path) {
    std::vector<wchar_t> name(path.size()+16);DWORD size=GetFinalPathNameByHandleW(handle,name.data(),static_cast<DWORD>(name.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    if(!size||size>=name.size()||std::wstring(name.data())!=L"\\\\?\\"+path)throw WinError("handle-final-name",ERROR_INVALID_NAME);
}
struct Pinned {
    std::wstring path;bool directory;Handle handle;Identity id;
    Pinned(const std::wstring& name,bool dir,DWORD access=READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,DWORD share=FILE_SHARE_READ|FILE_SHARE_WRITE)
        :path(name),directory(dir),handle(CreateFileW(filesystemPath(name).c_str(),access,share,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|(dir?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr)) {
        if(handle.value==INVALID_HANDLE_VALUE)throw WinError("pin-open");id=identity(handle.value,dir);finalName(handle.value,name);
    }
    void verify() const {if(!(identity(handle.value,directory)==id))throw WinError("pin-identity",ERROR_INVALID_DATA);finalName(handle.value,path);}
};
inline std::vector<std::wstring> entries(const std::wstring& root,size_t cap=8192) {
    WIN32_FIND_DATAW info={};HANDLE search=FindFirstFileW((filesystemPath(root)+L"\\*").c_str(),&info);if(search==INVALID_HANDLE_VALUE)throw WinError("tree-enumerate");
    std::vector<std::wstring> names;DWORD error=ERROR_SUCCESS;
    do{std::wstring name=info.cFileName;if(name!=L"."&&name!=L".."){if(names.size()>=cap){FindClose(search);throw WinError("tree-bound",ERROR_BUFFER_OVERFLOW);}names.push_back(name);}}while(FindNextFileW(search,&info));
    error=GetLastError();FindClose(search);if(error!=ERROR_NO_MORE_FILES)throw WinError("tree-enumerate",error);std::sort(names.begin(),names.end());return names;
}
inline void exactEntries(const std::wstring& path,std::vector<std::wstring> expected) {std::sort(expected.begin(),expected.end());if(entries(path,expected.size()+1)!=expected)throw WinError("tree-allowlist",ERROR_INVALID_DATA);}
inline std::vector<BYTE> aclBytes(const Owner& owner,PSID package,DWORD rights,bool inherit) {
    EXPLICIT_ACCESSW rules[3]={};DWORD count=package?3:2;
    for(DWORD i=0;i<count;++i){rules[i].grfAccessMode=SET_ACCESS;rules[i].grfInheritance=inherit?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;rules[i].Trustee.TrusteeForm=TRUSTEE_IS_SID;}
    rules[0].grfAccessPermissions=FILE_ALL_ACCESS;rules[0].Trustee.ptstrName=reinterpret_cast<LPWSTR>(owner.sid());
    rules[1].grfAccessPermissions=FILE_ALL_ACCESS;rules[1].Trustee.ptstrName=reinterpret_cast<LPWSTR>(owner.system.value);
    if(package){rules[2].grfAccessPermissions=rights;rules[2].Trustee.ptstrName=reinterpret_cast<LPWSTR>(package);}
    LocalMemory memory;DWORD error=SetEntriesInAclW(count,rules,nullptr,reinterpret_cast<PACL*>(&memory.value));if(error)throw WinError("acl-create",error);
    auto acl=static_cast<PACL>(memory.value);return {reinterpret_cast<BYTE*>(acl),reinterpret_cast<BYTE*>(acl)+acl->AclSize};
}
inline void verifyAcl(HANDLE handle,SE_OBJECT_TYPE type,const Owner& owner,PSID package,DWORD rights,bool inherit,bool requireOwner=true) {
    LocalMemory descriptor;PACL acl=nullptr;PSID actualOwner=nullptr;
    DWORD error=GetSecurityInfo(handle,type,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&actualOwner,nullptr,&acl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    if(error)throw WinError("acl-readback",error);SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;
    bool valid=(!requireOwner||EqualSid(actualOwner,owner.sid()))&&GetSecurityDescriptorControl(descriptor.value,&control,&revision)&&(control&SE_DACL_PROTECTED)&&acl&&acl->AceCount==(package?3:2);
    bool ownerSeen=false,systemSeen=false,packageSeen=false;
    for(DWORD i=0;valid&&i<acl->AceCount;++i){void* value=nullptr;valid=GetAce(acl,i,&value)!=FALSE;if(!valid)break;auto ace=static_cast<ACCESS_ALLOWED_ACE*>(value);
        valid=ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Header.AceFlags==(inherit?(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE):0);
        if(EqualSid(&ace->SidStart,owner.sid())&&!ownerSeen&&ace->Mask==FILE_ALL_ACCESS)ownerSeen=true;
        else if(EqualSid(&ace->SidStart,owner.system.value)&&!systemSeen&&ace->Mask==FILE_ALL_ACCESS)systemSeen=true;
        else if(package&&EqualSid(&ace->SidStart,package)&&!packageSeen&&ace->Mask==rights)packageSeen=true;
        else valid=false;
    }
    if(!valid||!ownerSeen||!systemSeen||(package&&!packageSeen))throw WinError("acl-policy",ERROR_INVALID_ACL);
}
inline void requireOwner(HANDLE handle,const Owner& owner) {
    LocalMemory descriptor;PSID actual=nullptr;DWORD error=GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&actual,nullptr,nullptr,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
    if(error||!actual||!EqualSid(actual,owner.sid()))throw WinError("resource-owner",error?error:ERROR_ACCESS_DENIED);
}
inline void setAcl(Pinned& pin,const Owner& owner,PSID package=nullptr,DWORD rights=0,bool inherit=false) {
    pin.verify();requireOwner(pin.handle.value,owner);auto bytes=aclBytes(owner,package,rights,inherit);
    DWORD error=SetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,reinterpret_cast<PACL>(bytes.data()),nullptr);
    if(error)throw WinError("acl-set",error);verifyAcl(pin.handle.value,SE_FILE_OBJECT,owner,package,rights,inherit);
}
inline void label(Pinned& pin,DWORD rid,bool inherit,bool apply) {
    LocalMemory descriptor;std::wstring sddl=L"S:(ML;"+std::wstring(inherit?L"OICI":L"")+L";NW;;;"+(rid==SECURITY_MANDATORY_LOW_RID?L"LW":L"ME")+L")";
    if(apply){if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value),nullptr))throw WinError("label-create");
        PACL sacl=nullptr;BOOL present=FALSE,defaulted=FALSE;if(!GetSecurityDescriptorSacl(descriptor.value,&present,&sacl,&defaulted)||!present)throw WinError("label-source");
        DWORD error=SetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,sacl);if(error)throw WinError("label-set",error);}
    LocalMemory readback;PACL sacl=nullptr;DWORD error=GetSecurityInfo(pin.handle.value,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,&sacl,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&readback.value));
    if(error||!sacl||sacl->AceCount!=1)throw WinError("label-readback",error?error:ERROR_INVALID_ACL);
    void* value=nullptr;if(!GetAce(sacl,0,&value))throw WinError("label-ace");auto ace=static_cast<SYSTEM_MANDATORY_LABEL_ACE*>(value);PSID sid=&ace->SidStart;
    if(ace->Header.AceType!=SYSTEM_MANDATORY_LABEL_ACE_TYPE||ace->Header.AceFlags!=(inherit?(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE):0)||
        ace->Mask!=SYSTEM_MANDATORY_LABEL_NO_WRITE_UP||!IsValidSid(sid)||*GetSidSubAuthorityCount(sid)!=1||*GetSidSubAuthority(sid,0)!=rid)throw WinError("label-policy",ERROR_INVALID_ACL);
}
inline std::string readSmall(HANDLE handle,size_t cap) {
    LARGE_INTEGER size={};if(!GetFileSizeEx(handle,&size)||size.QuadPart<0||uint64_t(size.QuadPart)>cap)throw WinError("bounded-file-size",ERROR_INVALID_DATA);
    LARGE_INTEGER zero={};if(!SetFilePointerEx(handle,zero,nullptr,FILE_BEGIN))throw WinError("file-rewind");std::string result(static_cast<size_t>(size.QuadPart),'\0');DWORD got=0;
    if(!ReadFile(handle,result.data(),static_cast<DWORD>(result.size()),&got,nullptr)||got!=result.size())throw WinError("bounded-file-read");return result;
}
inline std::string hashBytes(const BYTE* data,size_t size) {
    BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<BYTE,32> digest={};
    if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("sha-provider");
    auto status=BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0);if(status>=0)status=BCryptHashData(hash,const_cast<PUCHAR>(data),static_cast<ULONG>(size),0);
    if(status>=0)status=BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0);if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(alg,0);
    if(status<0)throw WinError("sha-data");std::string result;for(BYTE b:digest){result+="0123456789abcdef"[b>>4];result+="0123456789abcdef"[b&15];}return result;
}
inline std::string hashFile(HANDLE handle,uint64_t expected) {
    LARGE_INTEGER length={};if(!GetFileSizeEx(handle,&length)||length.QuadPart<0||uint64_t(length.QuadPart)!=expected||expected>256ULL*1024*1024)throw WinError("pin-size",ERROR_INVALID_DATA);
    BCRYPT_ALG_HANDLE alg=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<BYTE,32> digest={};
    if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("sha-provider");
    try{if(BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0)<0)throw WinError("sha-create");std::array<BYTE,65536> buffer={};uint64_t total=0;
        for(;;){DWORD got=0;if(!ReadFile(handle,buffer.data(),static_cast<DWORD>(buffer.size()),&got,nullptr))throw WinError("sha-read");if(!got)break;total+=got;
            if(total>expected||BCryptHashData(hash,buffer.data(),got,0)<0)throw WinError("sha-update");}
        if(total!=expected||BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0)<0)throw WinError("sha-finish");
    }catch(...){if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(alg,0);throw;}
    BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(alg,0);std::string result;for(BYTE b:digest){result+="0123456789abcdef"[b>>4];result+="0123456789abcdef"[b&15];}return result;
}
inline std::string idText(const Identity& id) {std::array<BYTE,12> bytes={};put(bytes.data(),id.volume,4);put(bytes.data()+4,id.high,4);put(bytes.data()+8,id.low,4);std::string result;for(BYTE b:bytes){result+="0123456789abcdef"[b>>4];result+="0123456789abcdef"[b&15];}return result;}
inline std::wstring widen(const std::string& value){return {value.begin(),value.end()};}
inline void writeFile(HANDLE handle,const std::string& value) {LARGE_INTEGER zero={};if(!SetFilePointerEx(handle,zero,nullptr,FILE_BEGIN))throw WinError("journal-rewind");writeAll(handle,reinterpret_cast<const BYTE*>(value.data()),value.size());if(!SetEndOfFile(handle)||!FlushFileBuffers(handle))throw WinError("journal-flush");}
inline SECURITY_ATTRIBUTES privateAttributes(const Owner& owner,LocalMemory& descriptor) {
    auto text=L"O:"+owner.text+L"D:P(A;;FA;;;"+owner.text+L")(A;;FA;;;SY)";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value),nullptr))throw WinError("private-descriptor");
    return {sizeof(SECURITY_ATTRIBUTES),descriptor.value,FALSE};
}
}
