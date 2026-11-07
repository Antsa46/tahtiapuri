#pragma once
#include "broker-release-codec.h"
#include "broker-release-io.h"
#include "broker-session.h"

namespace mcp_runtime {
inline bool releaseEntryPresent(const std::wstring& path){
    const DWORD attributes=GetFileAttributesW(extended(path).c_str());
    if(attributes!=INVALID_FILE_ATTRIBUTES){
        if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)throw WinError("mcp-release-reparse",ERROR_REPARSE_TAG_INVALID);
        return true;
    }
    const DWORD error=GetLastError();
    if(error==ERROR_FILE_NOT_FOUND)return false;
    throw WinError("mcp-release-presence-uncertain",error);
}
inline std::array<uint8_t,32> releaseHashBytes(const std::string& text){
    if(!journalHashText(text))throw WinError("mcp-release-hash",ERROR_INVALID_DATA);
    std::array<uint8_t,32> bytes={};
    auto nibble=[](char c){return static_cast<uint8_t>(c<='9'?c-'0':c-'a'+10);};
    for(size_t i=0;i<bytes.size();++i)bytes[i]=static_cast<uint8_t>((nibble(text[2*i])<<4)|nibble(text[2*i+1]));
    return bytes;
}
inline const std::array<std::wstring,brokerReleaseFiles>& releasePackageLeaves(){
    static const std::array<std::wstring,brokerReleaseFiles> names={
        L"licenses/mcp-core-LICENSE.txt",L"licenses/mcp-server-LICENSE.txt",L"licenses/node-LICENSE.txt",L"licenses/zod-LICENSE.txt",
        L"mcp-worker.mjs",L"node.exe",L"package.json",L"runtime-manifest.json"};
    return names;
}
inline std::array<const RuntimePin*,brokerReleaseFiles> releaseCompiledPins(){
    std::array<const RuntimePin*,brokerReleaseFiles> pins={};
    for(const auto& pin:runtimePins){
        const auto& names=releasePackageLeaves();const auto found=std::find(names.begin(),names.end(),pin.path);
        if(found==names.end())throw WinError("mcp-release-compiled-pins",ERROR_INVALID_DATA);
        const auto index=static_cast<size_t>(found-names.begin());
        if(pins[index])throw WinError("mcp-release-compiled-pins",ERROR_INVALID_DATA);
        pins[index]=&pin;
    }
    for(const auto* pin:pins)if(!pin)throw WinError("mcp-release-compiled-pins",ERROR_INVALID_DATA);
    return pins;
}
class NativeReleaseRecord {
    BootstrapDirectoryGuard& control;std::unique_ptr<BootstrapPin> file;bool fresh;const NativeReleaseRecordIo& io;
    static std::unique_ptr<BootstrapPin> open(BootstrapDirectoryGuard& guard,const wchar_t* leaf,bool create,uint64_t deadline){
        if(!leaf||(std::wstring(leaf)!=sessionReleaseLeaf&&std::wstring(leaf)!=sessionReleasedLeaf))
            throw WinError("mcp-release-record-leaf",ERROR_INVALID_NAME);
        guard.verify();const auto path=guard.root+L"\\"+leaf;requireSessionBudget(deadline);
        return std::make_unique<BootstrapPin>(path,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,create?CREATE_NEW:OPEN_EXISTING,0);
    }
public:
    NativeReleaseRecord(BootstrapDirectoryGuard& guard,const wchar_t* leaf,bool create,uint64_t deadline,
        const NativeReleaseRecordIo& recordIo=windowsReleaseRecordIo()):control(guard),
        file(open(guard,leaf,create,deadline)),fresh(create),io(recordIo){verify();}
    void verify(){
        if(!file)throw WinError("mcp-release-record-closed",ERROR_INVALID_STATE);
        control.verify();file->verify();requireBootstrapAcl(file->handle.value,control.owner,false);
    }
    JournalFileIdentity identity()const{return sessionFileIdentity(file->initial);}
    JournalBytes read(){
        verify();const auto before=file->inspect();
        if(before.nFileSizeHigh||before.nFileSizeLow!=1024)throw WinError("mcp-release-record-length",ERROR_INVALID_DATA);
        if(!io.seek(file->handle.value))throw WinError("mcp-release-seek");
        JournalBytes bytes={};DWORD count=0;
        if(!io.read(file->handle.value,bytes,count))throw WinError("mcp-release-read");
        if(count!=bytes.size())throw WinError("mcp-release-read-count",ERROR_READ_FAULT);
        const auto after=file->inspect();
        if(after.nFileSizeHigh||after.nFileSizeLow!=1024)throw WinError("mcp-release-record-length",ERROR_INVALID_DATA);
        verify();return bytes;
    }
    void writeNew(const JournalBytes& bytes,uint64_t deadline=0){
        verify();const auto initial=file->inspect();
        if(!fresh||initial.nFileSizeHigh||initial.nFileSizeLow)throw WinError("mcp-release-create-once",ERROR_INVALID_STATE);
        DWORD count=0;requireSessionBudget(deadline);fresh=false;
        if(!io.seek(file->handle.value))throw WinError("mcp-release-seek");
        requireSessionBudget(deadline);
        if(!io.write(file->handle.value,bytes,count))throw WinError("mcp-release-write");
        if(count!=bytes.size())throw WinError("mcp-release-write-count",ERROR_WRITE_FAULT);
        requireSessionBudget(deadline);
        if(!io.truncate(file->handle.value))throw WinError("mcp-release-end");
        requireSessionBudget(deadline);
        if(!io.flush(file->handle.value))throw WinError("mcp-release-flush");
        if(read()!=bytes)throw WinError("mcp-release-readback",ERROR_INVALID_DATA);
        requireSessionBudget(deadline);verify();
    }
    // A prior failed flush may have left complete bytes. A retry must establish
    // durability again, never infer it merely from a valid checksum.
    void durable(const JournalBytes& bytes,uint64_t deadline=0){
        verify();requireSessionBudget(deadline);if(!io.flush(file->handle.value))throw WinError("mcp-release-flush");
        if(read()!=bytes)throw WinError("mcp-release-readback",ERROR_INVALID_DATA);
        requireSessionBudget(deadline);
    }
    void close(){verify();closeBootstrapHandle(*file);file.reset();}
};
class NativePristineInventory {
    BootstrapDirectoryGuard& control;
    std::array<std::wstring,brokerReleaseTargets> paths;
    std::array<std::unique_ptr<BootstrapPin>,brokerReleaseTargets> pins;
    std::array<BrokerReleaseTarget,brokerReleaseTargets> targets={};
    size_t cursor=0;
    static constexpr int parents[brokerReleaseTargets]={8,8,8,8,9,9,9,9,9,11,11,12,-1};
    void verifyShape(){
        control.verify();
        for(size_t i=cursor;i<pins.size();++i){
            auto& pin=*pins[i];pin.verify();
            resourceAcl(pin,control.owner,nullptr,0,i>=brokerReleaseFiles,false,true);
            if(!journalIdentityEqual(targets[i].identity,sessionFileIdentity(pin.initial)))
                throw WinError("mcp-release-target-changed",ERROR_ACCESS_DENIED);
            if(i<brokerReleaseFiles){
                const auto current=pin.inspect();
                if((uint64_t(current.nFileSizeHigh)<<32|current.nFileSizeLow)!=targets[i].bytes)
                    throw WinError("mcp-release-target-size",ERROR_INVALID_DATA);
            }else{
                std::vector<std::wstring> expected;
                for(size_t child=cursor;child<pins.size();++child)if(parents[child]==static_cast<int>(i)){
                    const auto slash=paths[child].find_last_of(L'\\');expected.push_back(paths[child].substr(slash+1));
                }
                exactChildren(paths[i],expected);
            }
        }
    }
public:
    NativePristineInventory(BootstrapDirectoryGuard& guard,const BrokerReleaseIntent* expected):control(guard){
        const auto reservation=guard.root+L"\\native-session-reserved",stage=reservation+L"\\worker",package=stage+L"\\package";
        const auto compiled=releaseCompiledPins();const auto& leaves=releasePackageLeaves();
        if(expected)for(size_t i=0;i<brokerReleaseFiles;++i)
            if(expected->targets[i].bytes!=compiled[i]->bytes||expected->targets[i].digest!=releaseHashBytes(compiled[i]->sha256))
                throw WinError("mcp-release-intent-package",ERROR_ACCESS_DENIED);
        for(size_t i=0;i<brokerReleaseFiles;++i){auto leaf=leaves[i];std::replace(leaf.begin(),leaf.end(),L'/',L'\\');paths[i]=package+L"\\"+leaf;}
        paths[8]=package+L"\\licenses";paths[9]=package;paths[10]=stage+L"\\scratch";paths[11]=stage;paths[12]=reservation;
        std::array<bool,brokerReleaseTargets> present={};
        // Parents are queried first. PATH_NOT_FOUND is never an absence proof;
        // children of a specifically absent pinned-ancestor path are absent by
        // construction, without issuing an ambiguous descendant query.
        // Pin each present parent before querying any descendant. A malformed
        // junction must never turn an existence query into a foreign lookup.
        // These DELETE handles deny writers/deleters for the remaining tree.
        for(size_t reverse=paths.size();reverse>0;--reverse){
            const auto i=reverse-1;const int parent=parents[i];
            present[i]=parent>=0&&!present[static_cast<size_t>(parent)]?false:releaseEntryPresent(paths[i]);
            if(!present[i])continue;
            const bool directory=i>=brokerReleaseFiles;
            pins[i]=std::make_unique<BootstrapPin>(paths[i],directory,
                DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|(directory?FILE_LIST_DIRECTORY:GENERIC_READ),OPEN_EXISTING,FILE_SHARE_READ);
            auto& pin=*pins[i];resourceAcl(pin,control.owner,nullptr,0,directory,false,true);
            targets[i].identity=sessionFileIdentity(pin.initial);
            if(!directory){
                targets[i].bytes=compiled[i]->bytes;const auto actual=fileDigest(pin,compiled[i]->bytes);
                if(actual!=compiled[i]->sha256||(i==7&&actual!=runtimePackageDigest))throw WinError("mcp-release-target-hash",ERROR_INVALID_DATA);
                targets[i].digest=releaseHashBytes(actual);
            }
            if(expected){
                const auto& prior=expected->targets[i];
                if(!journalIdentityEqual(targets[i].identity,prior.identity)||targets[i].bytes!=prior.bytes||targets[i].digest!=prior.digest)
                    throw WinError("mcp-release-target-binding",ERROR_ACCESS_DENIED);
            }
        }
        cursor=brokerReleasePrefix(present);
        if(!expected&&cursor!=0)throw WinError("mcp-release-initial-tree",ERROR_INVALID_STATE);
        verifyShape();
    }
    const auto& identities()const{return targets;}
    size_t frontier()const{return cursor;}
    void verify(){verifyShape();}
    void removeNext(uint64_t deadline){
        if(cursor>=pins.size())throw WinError("mcp-release-already-removed",ERROR_INVALID_STATE);
        verifyShape();auto& pin=*pins[cursor];
        FILE_DISPOSITION_INFO disposition={TRUE};requireSessionBudget(deadline);
        if(!SetFileInformationByHandle(pin.handle.value,FileDispositionInfo,&disposition,sizeof(disposition)))
            throw WinError("mcp-release-delete");
        closeBootstrapHandle(pin);pins[cursor].reset();
        // Delete-pending, access-denied or another holder is not success.
        control.verify();requireBootstrapAbsent(paths[cursor]);++cursor;verifyShape();
    }
};
inline void requireReleaseControlShape(BootstrapDirectoryGuard& control,size_t frontier,bool completed){
    std::vector<std::wstring> expected={sessionLeaseLeaf,sessionRecordLeaf,sessionReleaseLeaf};
    if(frontier<brokerReleaseTargets)expected.push_back(L"native-session-reserved");
    if(completed)expected.push_back(sessionReleasedLeaf);
    exactChildren(control.root,expected);
}
inline void releasePristineBrokerSession(const std::wstring& path,const MainBootstrap& bootstrap,
    uint64_t deadline,const std::function<void(size_t)>& afterBoundary={},
    const NativeReleaseRecordIo& intentIo=windowsReleaseRecordIo(),const NativeReleaseRecordIo& completionIo=windowsReleaseRecordIo()){
    if(!deadline)throw WinError("mcp-release-deadline",ERROR_INVALID_PARAMETER);
    requireSessionBudget(deadline);requirePublishingMain(bootstrap);BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,false);
    NativeSessionFile state(control,lease,false);const auto session=state.load();requireSessionContext(session,control,lease,bootstrap);
    if(session.phase!=SessionPhase::Ready)throw WinError("mcp-release-not-pristine",ERROR_INVALID_STATE);
    const auto sessionBytes=encodeBrokerSession(session,journalDigest);
    const auto sessionDigest=journalDigest(sessionBytes.data(),sessionBytes.size());
    auto recheck=[&]{
        requireSessionBudget(deadline);requirePublishingMain(bootstrap);state.verify();
        if(encodeBrokerSession(state.load(),journalDigest)!=sessionBytes)throw WinError("mcp-release-session-changed",ERROR_ACCESS_DENIED);
        requireBootstrapAbsent(control.path);requireBootstrapAbsent(control.root+L"\\main-bootstrap.pending");requireSessionBudget(deadline);
    };
    recheck();const bool priorIntent=releaseEntryPresent(control.root+L"\\"+sessionReleaseLeaf);
    const bool priorCompletion=releaseEntryPresent(control.root+L"\\"+sessionReleasedLeaf);
    if(priorCompletion&&!priorIntent)throw WinError("mcp-release-orphan-completion",ERROR_INVALID_STATE);
    std::unique_ptr<NativeReleaseRecord> intent;BrokerReleaseIntent record;JournalBytes intentBytes={};
    if(priorIntent){
        intent=std::make_unique<NativeReleaseRecord>(control,sessionReleaseLeaf,false,deadline,intentIo);intentBytes=intent->read();
        record=decodeBrokerReleaseIntent(intentBytes.data(),intentBytes.size(),journalDigest);
        if(encodeBrokerSession(record.session,journalDigest)!=sessionBytes||record.sessionDigest!=sessionDigest
           ||!journalIdentityEqual(record.sessionFile,sessionFileIdentity(state.identity()))
           ||!journalIdentityEqual(record.intentFile,intent->identity()))
            throw WinError("mcp-release-intent-context",ERROR_ACCESS_DENIED);
    }
    NativePristineInventory inventory(control,priorIntent?&record:nullptr);
    if(!priorIntent){
        record.session=session;record.sessionFile=sessionFileIdentity(state.identity());record.sessionDigest=sessionDigest;record.targets=inventory.identities();
        exactChildren(control.root,{sessionLeaseLeaf,sessionRecordLeaf,L"native-session-reserved"});
        recheck();intent=std::make_unique<NativeReleaseRecord>(control,sessionReleaseLeaf,true,deadline,intentIo);record.intentFile=intent->identity();
        intentBytes=encodeBrokerReleaseIntent(record,journalDigest);intent->writeNew(intentBytes,deadline);
    }
    requireReleaseControlShape(control,inventory.frontier(),priorCompletion);
    BrokerReleaseCompletion completion;completion.intentDigest=journalDigest(intentBytes.data(),intentBytes.size());completion.sessionDigest=sessionDigest;
    completion.intentFile=intent->identity();completion.control=session.control;completion.lease=session.lease;
    completion.main=session.main;completion.generation=session.generation;
    const auto completionBytes=encodeBrokerReleaseCompletion(completion,journalDigest);
    std::unique_ptr<NativeReleaseRecord> done;
    if(priorCompletion){
        if(inventory.frontier()!=brokerReleaseTargets)throw WinError("mcp-release-premature-completion",ERROR_INVALID_STATE);
        done=std::make_unique<NativeReleaseRecord>(control,sessionReleasedLeaf,false,deadline,completionIo);
        const auto prior=done->read();(void)decodeBrokerReleaseCompletion(prior.data(),prior.size(),journalDigest);
        if(prior!=completionBytes)throw WinError("mcp-release-completion-context",ERROR_ACCESS_DENIED);
        intent->durable(intentBytes,deadline);done->durable(completionBytes,deadline);
    }else{
        intent->durable(intentBytes,deadline);recheck();inventory.verify();
        // Internal dependency seam for interruption tests; no production CLI
        // argument or runtime flag can enable it.
        if(afterBoundary)afterBoundary(inventory.frontier());
        while(inventory.frontier()<brokerReleaseTargets){
            recheck();requireReleaseControlShape(control,inventory.frontier(),false);
            inventory.removeNext(deadline);if(afterBoundary)afterBoundary(inventory.frontier());
        }
        recheck();requireReleaseControlShape(control,brokerReleaseTargets,false);
        done=std::make_unique<NativeReleaseRecord>(control,sessionReleasedLeaf,true,deadline,completionIo);done->writeNew(completionBytes,deadline);
    }
    recheck();requireReleaseControlShape(control,brokerReleaseTargets,true);
    done->close();intent->close();state.close();lease.close();requireSessionBudget(deadline);
}
}
