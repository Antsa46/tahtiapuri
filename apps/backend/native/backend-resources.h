#pragma once
#include "backend-security.h"
#include "backend-runtime-pins.h"

// These helpers own only the fixed backend state and the derived run directory.
// No destructor repairs ACLs or removes data: the broker must first prove Job emptiness.
namespace backend_runtime {
constexpr size_t resourceNodeLimit=8192;
constexpr unsigned resourceDepthLimit=32;
constexpr DWORD workerRead=FILE_GENERIC_READ|FILE_GENERIC_EXECUTE;
constexpr DWORD workerWrite=FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE|DELETE|FILE_DELETE_CHILD;
inline std::wstring parentPath(const std::wstring& path) {
    auto split=path.find_last_of(L'\\');if(split==std::wstring::npos||split<3)throw WinError("resource-parent",ERROR_INVALID_NAME);return path.substr(0,split);
}
inline std::string narrow(const std::wstring& value) {
    std::string out;for(wchar_t c:value){if(c<32||c>126)throw WinError("resource-ascii",ERROR_INVALID_DATA);out+=static_cast<char>(c);}return out;
}
inline std::wstring ownerTag(const Owner& owner) {auto s=narrow(owner.text);return widen(hashBytes(reinterpret_cast<const BYTE*>(s.data()),s.size()).substr(0,16));}
inline std::wstring jobName(const Owner& owner,const std::wstring& run) {
    if(!lowerHex(run,32))throw WinError("run-nonce",ERROR_INVALID_DATA);return L"Global\\Tahtiapuri.Backend."+ownerTag(owner)+L"."+run;
}
inline std::wstring profileName(const Owner& owner,const std::wstring& run) {
    if(!lowerHex(run,32))throw WinError("run-nonce",ERROR_INVALID_DATA);return L"tahtiapuri.backend."+ownerTag(owner).substr(0,8)+L"."+run;
}
inline std::wstring sessionPath(const std::wstring& state,const std::wstring& run) {
    if(!lowerHex(run,32))throw WinError("session-nonce",ERROR_INVALID_DATA);return parentPath(state)+L"\\native-backend\\sessions\\run-"+run;
}
inline bool existsStrict(const std::wstring& path) {
    DWORD attrs=GetFileAttributesW(filesystemPath(path).c_str());if(attrs!=INVALID_FILE_ATTRIBUTES)return true;
    DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)return false;throw WinError("resource-existence",error);
}
inline void privateDirectory(const std::wstring& path,const Owner& owner) {
    LocalMemory sd;auto sa=privateAttributes(owner,sd);if(!CreateDirectoryW(filesystemPath(path).c_str(),&sa))throw WinError("private-directory-create");
    Pinned pin(path,true);setAcl(pin,owner);label(pin,SECURITY_MANDATORY_MEDIUM_RID,false,true);
}
inline void privateFileCreate(const std::wstring& path,const Owner& owner,const std::string& body) {
    LocalMemory sd;auto sa=privateAttributes(owner,sd);Handle file(CreateFileW(filesystemPath(path).c_str(),GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER,
        0,&sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_WRITE_THROUGH,nullptr));
    if(file.value==INVALID_HANDLE_VALUE)throw WinError("private-file-create");identity(file.value,false);finalName(file.value,path);writeFile(file.value,body);
    closeHandle(file);Pinned pin(path,false);setAcl(pin,owner);label(pin,SECURITY_MANDATORY_MEDIUM_RID,false,true);
}
inline void privatePolicy(Pinned& pin,const Owner& owner) {
    pin.verify();requireOwner(pin.handle.value,owner);verifyAcl(pin.handle.value,SE_FILE_OBJECT,owner,nullptr,0,false);label(pin,SECURITY_MANDATORY_MEDIUM_RID,false,false);
}
inline void baselinePolicy(Pinned& pin,const Owner& owner,bool apply) {
    if(apply)setAcl(pin,owner,nullptr,0,pin.directory);
    else {requireOwner(pin.handle.value,owner);verifyAcl(pin.handle.value,SE_FILE_OBJECT,owner,nullptr,0,pin.directory);}
    label(pin,SECURITY_MANDATORY_MEDIUM_RID,pin.directory,apply);
}
inline std::vector<std::unique_ptr<Pinned>> pinAncestors(const std::wstring& path) {
    canonicalPath(path);std::vector<std::unique_ptr<Pinned>> result;
    // Drive roots have a trailing slash and are checked separately from canonicalPath.
    result.push_back(std::make_unique<Pinned>(path.substr(0,3),true,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE));
    for(size_t split=3;(split=path.find(L'\\',split))!=std::wstring::npos;++split)
        result.push_back(std::make_unique<Pinned>(path.substr(0,split),true,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE));
    return result;
}
struct Ownership {
    Owner owner;std::wstring stateRoot,controlRoot,dataRoot;bool created=false;
    std::vector<std::unique_ptr<Pinned>> ancestors;
    std::unique_ptr<Pinned> state,control,data,marker;Handle lock;
    explicit Ownership(const std::wstring& supplied):stateRoot(canonicalPath(supplied)),controlRoot(stateRoot+L"\\control"),dataRoot(stateRoot+L"\\data") {
        if(stateRoot.substr(stateRoot.find_last_of(L'\\')+1)!=L"backend-state")throw WinError("state-root-name",ERROR_INVALID_NAME);
        ancestors=pinAncestors(stateRoot);
        if(!existsStrict(stateRoot)){privateDirectory(stateRoot,owner);created=true;}
        state=std::make_unique<Pinned>(stateRoot,true);privatePolicy(*state,owner);
        if(created){privateDirectory(controlRoot,owner);privateDirectory(dataRoot,owner);}
        exactEntries(stateRoot,{L"control",L"data"});control=std::make_unique<Pinned>(controlRoot,true);privatePolicy(*control,owner);
        LocalMemory sd;auto sa=privateAttributes(owner,sd);
        lock.value=CreateFileW(filesystemPath(controlRoot+L"\\owner.lock").c_str(),GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER,0,&sa,
            created?CREATE_NEW:OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        if(lock.value==INVALID_HANDLE_VALUE)throw WinError("state-exclusive-lock");identity(lock.value,false);finalName(lock.value,controlRoot+L"\\owner.lock");requireOwner(lock.value,owner);
        if(!SetHandleInformation(lock.value,HANDLE_FLAG_INHERIT,0))throw WinError("lock-noninherited");
        verifyAcl(lock.value,SE_FILE_OBJECT,owner,nullptr,0,false);
        data=std::make_unique<Pinned>(dataRoot,true);requireOwner(data->handle.value,owner);
        const auto body="TAHTIAPURI_BACKEND_STATE_V1\n"+narrow(owner.text)+"\n"+idText(state->id)+"\n"+idText(data->id)+"\n";
        if(created){baselinePolicy(*data,owner,true);privateDirectory(dataRoot+L"\\observing",owner);Pinned observing(dataRoot+L"\\observing",true);baselinePolicy(observing,owner,true);
            privateFileCreate(controlRoot+L"\\owner.marker",owner,body);}
        marker=std::make_unique<Pinned>(controlRoot+L"\\owner.marker",false,GENERIC_READ|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);
        privatePolicy(*marker,owner);if(readSmall(marker->handle.value,1024)!=body)throw WinError("state-marker",ERROR_INVALID_DATA);
        // Journal creation is exclusively Journal's responsibility, and only for this new root.
        exactEntries(controlRoot,created?std::vector<std::wstring>{L"owner.lock",L"owner.marker"}:std::vector<std::wstring>{L"owner.lock",L"owner.marker",L"recovery.journal"});
    }
    void verify() const {state->verify();control->verify();data->verify();marker->verify();for(const auto& pin:ancestors)pin->verify();}
};
inline std::wstring relativePin(const std::wstring& value) {
    if(value.empty()||value.size()>512||value.front()==L'/'||value.back()==L'/'||value.find(L"..")!=std::wstring::npos)throw WinError("compiled-pin-path",ERROR_INVALID_DATA);
    std::wstring out;for(wchar_t c:value){if(!((c>=L'a'&&c<=L'z')||(c>=L'A'&&c<=L'Z')||(c>=L'0'&&c<=L'9')||c==L'/'||c==L'.'||c==L'-'||c==L'_'||c==L'@'))throw WinError("compiled-pin-character",ERROR_INVALID_DATA);out+=c==L'/'?L'\\':c;}
    if(out.find(L"\\\\")!=std::wstring::npos)throw WinError("compiled-pin-component",ERROR_INVALID_DATA);return out;
}
struct ResourceTree {
    std::vector<std::unique_ptr<Pinned>> nodes;
    void walk(const std::wstring& path,const Owner& owner,unsigned depth=0) {
        if(depth>resourceDepthLimit||nodes.size()>=resourceNodeLimit)throw WinError("resource-tree-bound",ERROR_BUFFER_OVERFLOW);
        DWORD attrs=GetFileAttributesW(filesystemPath(path).c_str());if(attrs==INVALID_FILE_ATTRIBUTES||(attrs&FILE_ATTRIBUTE_REPARSE_POINT))throw WinError("resource-tree-reparse",ERROR_INVALID_DATA);
        bool dir=(attrs&FILE_ATTRIBUTE_DIRECTORY)!=0;auto node=std::make_unique<Pinned>(path,dir);requireOwner(node->handle.value,owner);
        nodes.push_back(std::move(node));if(dir)for(const auto& name:entries(path,resourceNodeLimit))walk(path+L"\\"+name,owner,depth+1);
    }
    void baseline(const Owner& owner,bool apply) {for(auto node=nodes.rbegin();node!=nodes.rend();++node)baselinePolicy(**node,owner,apply);}
    void grant(const Owner& owner,PSID sid) {for(auto node=nodes.rbegin();node!=nodes.rend();++node){setAcl(**node,owner,sid,workerWrite,(*node)->directory);label(**node,SECURITY_MANDATORY_LOW_RID,(*node)->directory,true);}}
};
struct Resources {
    Ownership& ownership;std::wstring run,root,packageRoot,scratchRoot,nodePath,entryPath;
    std::vector<std::unique_ptr<Pinned>> ancestors,package;std::unique_ptr<Pinned> session,marker,scratch;
    ResourceTree data;bool prepared=false;
    Resources(Ownership& owned,const std::wstring& nonce,bool validatePackage=true):ownership(owned),run(nonce),root(sessionPath(owned.stateRoot,nonce)),
        packageRoot(root+L"\\package"),scratchRoot(root+L"\\scratch"),nodePath(packageRoot+L"\\node.exe"),entryPath(packageRoot+L"\\backend\\dist\\runtime\\stdio-backend.js") {
        if(validatePackage)requireProcessPaths(packageRoot,nodePath);
        ownership.verify();ancestors=pinAncestors(root);session=std::make_unique<Pinned>(root,true);requireOwner(session->handle.value,owned.owner);
        exactEntries(root,{L"owner.marker",L"package",L"scratch"});
        marker=std::make_unique<Pinned>(root+L"\\owner.marker",false,GENERIC_READ|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);requireOwner(marker->handle.value,owned.owner);
        const auto expected="TAHTIAPURI_BACKEND_SESSION_V1\n"+narrow(run)+"\n"+std::string(runtimePackageDigest)+"\n";
        if(readSmall(marker->handle.value,1024)!=expected)throw WinError("session-marker",ERROR_INVALID_DATA);
        scratch=std::make_unique<Pinned>(scratchRoot,true);requireOwner(scratch->handle.value,owned.owner);
        if(validatePackage){exactEntries(scratchRoot,{});pinPackage();data.walk(owned.dataRoot,owned.owner);data.baseline(owned.owner,false);}
    }
    void verifyPackageShape() const {
        std::set<std::wstring> leaves,dirs={L""};for(const auto& pin:runtimePins){auto path=relativePin(pin.path);leaves.insert(path);for(size_t at=0;(at=path.find(L'\\',at))!=std::wstring::npos;++at)dirs.insert(path.substr(0,at));}
        for(const auto& dir:dirs){std::set<std::wstring> expected;auto base=dir.empty()?L"":dir+L"\\";
            for(const auto& leaf:leaves)if(leaf.compare(0,base.size(),base)==0){auto tail=leaf.substr(base.size());expected.insert(tail.substr(0,tail.find(L'\\')));}
            exactEntries(packageRoot+(dir.empty()?L"":L"\\"+dir),{expected.begin(),expected.end()});}
    }
    void pinPackage() {
        std::set<std::wstring> leaves,dirs={L""};bool node=false,entry=false,manifest=false;
        for(const auto& pin:runtimePins){auto path=relativePin(pin.path);if(!leaves.insert(path).second)throw WinError("duplicate-compiled-pin",ERROR_INVALID_DATA);
            if(!lowerHex(widen(pin.sha256),64))throw WinError("compiled-pin-digest",ERROR_INVALID_DATA);
            node|=path==L"node.exe";entry|=path==L"backend\\dist\\runtime\\stdio-backend.js";manifest|=path==L"runtime-manifest.json";
            for(size_t at=0;(at=path.find(L'\\',at))!=std::wstring::npos;++at)dirs.insert(path.substr(0,at));}
        if(!node||!entry||!manifest||!lowerHex(widen(runtimePackageDigest),64))throw WinError("required-runtime-pins",ERROR_INVALID_DATA);
        for(const auto& dir:dirs){auto path=packageRoot+(dir.empty()?L"":L"\\"+dir);auto pin=std::make_unique<Pinned>(path,true);requireOwner(pin->handle.value,ownership.owner);
            std::set<std::wstring> expected;auto base=dir.empty()?L"":dir+L"\\";
            for(const auto& leaf:leaves)if(leaf.compare(0,base.size(),base)==0){auto tail=leaf.substr(base.size());expected.insert(tail.substr(0,tail.find(L'\\')));}
            exactEntries(path,{expected.begin(),expected.end()});package.push_back(std::move(pin));}
        for(const auto& pin:runtimePins){auto path=relativePin(pin.path);auto file=std::make_unique<Pinned>(packageRoot+L"\\"+path,false,
            GENERIC_READ|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);requireOwner(file->handle.value,ownership.owner);
            auto digest=hashFile(file->handle.value,pin.bytes);if(digest!=pin.sha256||(path==L"runtime-manifest.json"&&digest!=runtimePackageDigest))throw WinError("package-pin-mismatch",ERROR_INVALID_DATA);package.push_back(std::move(file));}
    }
    void prepare(PSID sid) {
        if(prepared||!IsValidSid(sid)||package.empty()||data.nodes.empty())throw WinError("resource-prepare-state",ERROR_INVALID_STATE);
        ownership.verify();for(const auto& pin:package)pin->verify();for(const auto& pin:data.nodes)pin->verify();
        // All closed-tree validation and durable journal ownership must precede this call.
        // Seal the staged tree to owner+SYSTEM before any package grant, then check its
        // exact shape again. Handles deny file mutation, rename and replacement; this
        // second enumeration also rejects additions during the initial staging window.
        for(auto pin=package.rbegin();pin!=package.rend();++pin){setAcl(**pin,ownership.owner);label(**pin,SECURITY_MANDATORY_MEDIUM_RID,false,true);}
        setAcl(*marker,ownership.owner);setAcl(*scratch,ownership.owner);setAcl(*session,ownership.owner);verifyPackageShape();exactEntries(scratchRoot,{});exactEntries(root,{L"owner.marker",L"package",L"scratch"});
        for(auto pin=package.rbegin();pin!=package.rend();++pin)setAcl(**pin,ownership.owner,sid,workerRead,false);
        data.grant(ownership.owner,sid);
        // Mutable observing files are replaced by rename. Keep only Ownership's
        // data-root pin while running, and re-enumerate every descendant after Job 0.
        data.nodes.clear();setAcl(*scratch,ownership.owner,sid,workerWrite,true);label(*scratch,SECURITY_MANDATORY_LOW_RID,true,true);
        setAcl(*marker,ownership.owner);setAcl(*session,ownership.owner,sid,workerRead,false);prepared=true;
    }
    void closePins() {data.nodes.clear();package.clear();scratch.reset();marker.reset();session.reset();ancestors.clear();}
    static void restorePersistent(Ownership& owned) {owned.verify();ResourceTree current;current.walk(owned.dataRoot,owned.owner);current.baseline(owned.owner,true);}
    static void removeSession(Ownership& owned,const std::wstring& nonce,const std::string& expectedIdentity) {
        const auto path=sessionPath(owned.stateRoot,nonce);if(!existsStrict(path))return;
        // The journal binds the root identity before any grants. This also permits
        // retry after a crash halfway through deletion, with the marker removed last.
        auto ancestors=pinAncestors(path);{
            Pinned root(path,true);requireOwner(root.handle.value,owned.owner);if(idText(root.id)!=expectedIdentity)throw WinError("session-cleanup-identity",ERROR_INVALID_DATA);
            auto names=entries(path,4);for(const auto& name:names)if(name!=L"owner.marker"&&name!=L"package"&&name!=L"scratch")throw WinError("session-cleanup-shape",ERROR_INVALID_DATA);
            if(existsStrict(path+L"\\owner.marker")){Pinned marker(path+L"\\owner.marker",false,GENERIC_READ|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);requireOwner(marker.handle.value,owned.owner);
                if(readSmall(marker.handle.value,1024)!="TAHTIAPURI_BACKEND_SESSION_V1\n"+narrow(nonce)+"\n"+std::string(runtimePackageDigest)+"\n")throw WinError("session-cleanup-marker",ERROR_INVALID_DATA);
            }else if(!names.empty())throw WinError("session-cleanup-unmarked",ERROR_INVALID_DATA);
        }
        ResourceTree tree;tree.walk(path,owned.owner);
        for(auto node=tree.nodes.rbegin();node!=tree.nodes.rend();++node){auto name=(*node)->path;bool dir=(*node)->directory;
            (*node)->verify();(*node).reset();if(!(dir?RemoveDirectoryW(filesystemPath(name).c_str()):DeleteFileW(filesystemPath(name).c_str())))throw WinError("session-remove");}
    }
};
}
