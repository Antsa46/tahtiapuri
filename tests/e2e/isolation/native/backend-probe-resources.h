#pragma once
#include "backend-probe-wire.h"
#include "backend-probe-pins.h"
#include <set>
namespace backend_probe {
constexpr char workerMarker[]="TAHTIAPURI_BACKEND_PROBE", caseMarker[]="TAHTIAPURI_BACKEND_CASE";
constexpr wchar_t profilePrefix[]=L"tahtiapuri.backend.";
inline void exactStageEntries(const std::wstring& path, std::vector<std::wstring> expected) {
    isolation::exactEntries(filePath(path),std::move(expected));
}
inline std::string sha256(HANDLE file, uint64_t expected) {
    LARGE_INTEGER length={};
    if (!GetFileSizeEx(file,&length) || length.QuadPart<0 || static_cast<uint64_t>(length.QuadPart)!=expected || expected>160*1024*1024)
        throw WinError("resource-size",ERROR_INVALID_DATA);
    BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0) throw WinError("hash-provider");
    std::vector<BYTE> value(32),buffer(65536);
    try {
        if (BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)<0) throw WinError("hash-create");
        uint64_t total=0;
        for (;;) { DWORD count=0; if (!ReadFile(file,buffer.data(),static_cast<DWORD>(buffer.size()),&count,nullptr)) throw WinError("hash-read");
            if (!count) break;
            total+=count; if (total>expected || BCryptHashData(hash,buffer.data(),count,0)<0) throw WinError("hash-data",ERROR_INVALID_DATA); }
        if (total!=expected || BCryptFinishHash(hash,value.data(),32,0)<0) throw WinError("hash-finish",ERROR_INVALID_DATA);
    } catch (...) { if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm,0); throw; }
    BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm,0);
    std::string result; for (BYTE byte:value) { result+="0123456789abcdef"[byte>>4]; result+="0123456789abcdef"[byte&15]; } return result;
}
inline void pinDirectory(const std::wstring& path, Pins& pins) {
    regular(path,true);
    auto handle=std::make_unique<Handle>(CreateFileW(filePath(path).c_str(),FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    BY_HANDLE_FILE_INFORMATION info={};
    if (handle->value==INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle->value,&info) ||
        (info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT) || !(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))
        throw WinError("directory-pin",ERROR_INVALID_DATA);
    pins.handles.push_back(std::move(handle));
}
inline std::vector<std::wstring> directoryEntries(const std::wstring& root, size_t maxEntries) {
    WIN32_FIND_DATAW data={}; HANDLE search=FindFirstFileW((filePath(root)+L"\\*").c_str(),&data);
    if (search==INVALID_HANDLE_VALUE) throw WinError("owned-enumeration");
    std::vector<std::wstring> result;
    do { const std::wstring name=data.cFileName; if (name!=L"." && name!=L"..") {
        if (result.size()>=maxEntries) { FindClose(search); throw WinError("data-enumeration-limit",ERROR_INVALID_DATA); }
        result.push_back(name);
    } }
    while (FindNextFileW(search,&data));
    const DWORD error=GetLastError(); FindClose(search);
    if (error!=ERROR_NO_MORE_FILES) throw WinError("owned-enumeration",error); return result;
}
struct DataNode { std::wstring path; bool directory; };
inline void walkData(const std::wstring& root, unsigned depth, std::vector<DataNode>& nodes) {
    if (depth>8 || nodes.size()>=128) throw WinError("data-walk-limit",ERROR_INVALID_DATA);
    regular(root,true); nodes.push_back({root,true});
    for (const auto& name:directoryEntries(root,128-nodes.size())) {
        const auto path=root+L"\\"+name; const DWORD attrs=GetFileAttributesW(filePath(path).c_str());
        if (attrs==INVALID_FILE_ATTRIBUTES || (attrs&FILE_ATTRIBUTE_REPARSE_POINT)) throw WinError("data-reparse",ERROR_INVALID_DATA);
        if (attrs&FILE_ATTRIBUTE_DIRECTORY) walkData(path,depth+1,nodes);
        else { if (nodes.size()>=128) throw WinError("data-walk-limit",ERROR_INVALID_DATA); regular(path,false); nodes.push_back({path,false}); }
    }
}
inline std::wstring nativePath(const std::wstring& relative) {
    if (relative.empty() || relative.size()>240 || relative.front()==L'/' || relative.find(L"..")!=std::wstring::npos)
        throw WinError("pin-path",ERROR_INVALID_DATA);
    std::wstring result;
    for (wchar_t c:relative) {
        if (!((c>=L'a'&&c<=L'z') || (c>=L'A'&&c<=L'Z') || (c>=L'0'&&c<=L'9') ||
            c==L'/' || c==L'.' || c==L'-' || c==L'_' || c==L'@')) throw WinError("pin-path",ERROR_INVALID_DATA);
        result+=c==L'/'?L'\\':c;
    }
    if (result.back()==L'\\' || result.find(L"\\\\")!=std::wstring::npos) throw WinError("pin-path",ERROR_INVALID_DATA);
    return result;
}
struct Resources {
    std::wstring root,caseRoot,dataRoot; Pins pins;
    explicit Resources(const std::wstring& supplied) {
        root=ownedRoot(supplied,workerMarker); const auto split=root.find_last_of(L'\\');
        const auto name=root.substr(split+1);
        if (!ownedProfile(name,L"worker-")) throw WinError("worker-name",ERROR_INVALID_DATA);
        caseRoot=ownedRoot(root.substr(0,split),caseMarker); dataRoot=caseRoot+L"\\data";
        exactStageEntries(caseRoot,{L"owner.marker",L"data",name});
        pinDirectory(caseRoot,pins); pinDirectory(root,pins); pinDirectory(dataRoot,pins);
        pins.add(caseRoot+L"\\owner.marker"); pins.add(root+L"\\owner.marker");
    }
    void prepare(PSID sid) {
        std::vector<std::wstring> top={L"owner.marker",L"launcher",L"package",L"scratch",L"private",L"aap"};
        if (sid) top.push_back(L"profile.receipt"); exactStageEntries(root,top);
        exactStageEntries(root+L"\\launcher",{L"backend-probe-host.exe"});
        exactStageEntries(root+L"\\private",{L"secret.txt"}); exactStageEntries(root+L"\\aap",{L"read.txt"}); exactStageEntries(root+L"\\scratch",{});
        for (const auto& name:{L"launcher",L"private",L"scratch",L"aap"}) pinDirectory(root+L"\\"+name,pins);
        for (const auto& leaf:{L"launcher\\backend-probe-host.exe",L"private\\secret.txt",L"aap\\read.txt"}) {
            regular(root+L"\\"+leaf,false);
        }
        pins.add(root+L"\\launcher\\backend-probe-host.exe"); pins.add(root+L"\\private\\secret.txt");
        if (sid) { regular(root+L"\\profile.receipt",false); pins.add(root+L"\\profile.receipt"); }
        // Derive the complete directory allowlist solely from compiled file pins.
        std::set<std::wstring> leaves,dirs={L""};
        for (const auto& pin:backendPins) {
            const auto path=nativePath(pin.name);
            if (!leaves.insert(path).second) throw WinError("duplicate-pin",ERROR_INVALID_DATA);
            for (size_t at=0;(at=path.find(L'\\',at))!=std::wstring::npos;++at) dirs.insert(path.substr(0,at));
        }
        for (const auto& dir:dirs) {
            const auto path=root+L"\\package"+(dir.empty()?L"":L"\\"+dir); pinDirectory(path,pins);
            std::vector<std::wstring> expected;
            const auto base=dir.empty()?L"":dir+L"\\";
            for (const auto& leaf:leaves) if (leaf.compare(0,base.size(),base)==0) {
                const auto tail=leaf.substr(base.size()); expected.push_back(tail.substr(0,tail.find(L'\\')));
            }
            std::sort(expected.begin(),expected.end()); expected.erase(std::unique(expected.begin(),expected.end()),expected.end());
            exactStageEntries(path,expected);
        }
        for (const auto& pin:backendPins) {
            const auto name=nativePath(pin.name),path=root+L"\\package\\"+name;
            regular(path,false);
            if (name==L"code.txt") { Pins temporary; if (sha256(temporary.add(path),pin.bytes)!=pin.hash) throw WinError("resource-hash",ERROR_INVALID_DATA); }
            else if (sha256(pins.add(path),pin.bytes)!=pin.hash) throw WinError("resource-hash",ERROR_INVALID_DATA);
        }
        std::vector<DataNode> data; walkData(dataRoot,0,data);
        // Finish validation and pinning before any ACL mutation. Removing inherited
        // parent ACEs can otherwise leave still-unprotected descendants empty.
        for (const auto& pin:backendPins) setOwnedAcl(root+L"\\package\\"+nativePath(pin.name),sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
        for (const auto& leaf:{L"launcher\\backend-probe-host.exe",L"private\\secret.txt"}) setOwnedAcl(root+L"\\"+leaf,nullptr,0,false);
        if (sid) setOwnedAcl(root+L"\\profile.receipt",nullptr,0,false);
        setOwnedAcl(root+L"\\owner.marker",sid,FILE_GENERIC_READ,false);
        setOwnedAcl(caseRoot+L"\\owner.marker",sid,FILE_GENERIC_READ,false);
        PSID aap=nullptr;
        if (!ConvertStringSidToSidW(L"S-1-15-2-1",&aap)) throw WinError("aap-sid");
        std::unique_ptr<void,decltype(&LocalFree)> aapOwner(aap,&LocalFree);
        setOwnedAcl(root+L"\\aap\\read.txt",nullptr,0,false,aap);
        // Children have explicit protected ACLs before their parent is tightened.
        for (auto dir=dirs.rbegin();dir!=dirs.rend();++dir) {
            const auto path=root+L"\\package"+(dir->empty()?L"":L"\\"+*dir);
            setOwnedAcl(path,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
        }
        const DWORD writeRights=FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE|DELETE|FILE_DELETE_CHILD;
        for (auto node=data.rbegin();node!=data.rend();++node) {
            setOwnedAcl(node->path,sid,writeRights,node->directory); lowScratch(node->path);
        }
        setOwnedAcl(root+L"\\scratch",sid,writeRights,true); lowScratch(root+L"\\scratch");
        setOwnedAcl(root+L"\\launcher",nullptr,0,false); setOwnedAcl(root+L"\\private",nullptr,0,false);
        setOwnedAcl(root+L"\\aap",nullptr,0,false,aap);
        setOwnedAcl(root,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
        setOwnedAcl(caseRoot,sid,FILE_READ_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE|FILE_TRAVERSE,false);
    }
    void restorePersistent() {
        // The caller must prove Job emptiness before entering this walk.
        ownedRoot(root,workerMarker); ownedRoot(caseRoot,caseMarker);
        std::vector<DataNode> data; walkData(dataRoot,0,data);
        for (auto node=data.rbegin();node!=data.rend();++node) setOwnedAcl(node->path,nullptr,0,false);
        setOwnedAcl(caseRoot+L"\\owner.marker",nullptr,0,false);
        setOwnedAcl(caseRoot,nullptr,0,false);
    }
};
}
