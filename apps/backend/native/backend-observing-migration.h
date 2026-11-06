#pragma once
#include "backend-resources.h"
#include <cstddef>

// One native-owned, fixed-path transaction before any new worker/profile/grant.
// Main validates the storage envelope; it can select only a hash-bound action,
// never replacement content or a path. The Windows adapter holds the guard.
namespace backend_runtime {
constexpr size_t observingMigrationBytes=32768;
struct MigrationContext {std::string owner,state,data;};
struct MigrationSource {std::string bytes,identity;bool reserved=false;};
struct MigrationDestination {std::string bytes;bool present=false;};
struct MigrationMarker {std::string bytes;bool present=false;};
enum class MigrationSlot {Destination,Marker};
inline std::string migrationHash(const std::string& bytes){return hashBytes(reinterpret_cast<const BYTE*>(bytes.data()),bytes.size());}
inline void migrationRequire(bool valid,const char* stage){if(!valid)throw WinError(stage,ERROR_INVALID_DATA);}
inline void migrationSnapshot(const std::string& bytes){
    migrationRequire(!bytes.empty()&&bytes.size()<=observingMigrationBytes,"migration-snapshot-size");
    if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(bytes.size()),nullptr,0))throw WinError("migration-snapshot-utf8",ERROR_INVALID_DATA);
}
inline std::string migrationEmptyEnvelope(){
    const std::string state="{\"revision\":0,\"places\":[],\"activePlaceId\":null}";
    return "{\"schemaVersion\":1,\"state\":"+state+",\"sha256\":\""+migrationHash(state)+"\"}\n";
}
inline std::string migrationMarker(const MigrationContext& context,const MigrationSource& source,bool originallyAbsent){
    migrationRequire(lowerHex(widen(context.state),24)&&lowerHex(widen(context.data),24)&&lowerHex(widen(source.identity),24),"migration-marker-identities");
    const auto body="TAHTIAPURI_OBSERVING_MIGRATION_V1\nLEGACY_GUARD_STORAGE_V1\n"+context.owner+"\n"+context.state+"\n"+context.data+"\n"+source.identity+"\n"+migrationHash(source.bytes)+"\n"+(originallyAbsent?"1\n":"0\n");
    return body+migrationHash(body)+"\n";
}
inline bool migrationMarkerOrigin(const std::string& bytes){
    migrationRequire(!bytes.empty()&&bytes.size()<=2048&&bytes.back()=='\n',"migration-marker-shape");
    std::vector<std::string> lines;size_t begin=0;
    for(size_t at=0;at<bytes.size();++at){const auto c=static_cast<unsigned char>(bytes[at]);if(c=='\n'){lines.push_back(bytes.substr(begin,at-begin));begin=at+1;}else migrationRequire(c>=32&&c<=126,"migration-marker-ascii");}
    migrationRequire(lines.size()==9&&(lines[7]=="0"||lines[7]=="1"),"migration-marker-fields");return lines[7]=="1";
}
struct ObservingMigrationIo {
    virtual ~ObservingMigrationIo()=default;
    // Presence and malformed content differ. Leftover fixed temp slots block.
    virtual MigrationMarker marker()=0;
    virtual MigrationSource acquireSource(bool allowReservation)=0;
    virtual MigrationDestination destination()=0;
    virtual void verify(const MigrationSource&,const MigrationDestination&)=0;
    virtual void createTemp(MigrationSlot)=0;
    virtual void writeTemp(MigrationSlot,const std::string&)=0;
    virtual void flushTemp(MigrationSlot)=0;
    virtual std::string readTemp(MigrationSlot)=0;
    virtual void publishTemp(MigrationSlot)=0;
    virtual std::string readPublished(MigrationSlot)=0;
    virtual void releaseDestination()=0;
};
class ObservingMigration {
    MigrationContext context;ObservingMigrationIo& io;std::function<void()> check;
    MigrationSource source;MigrationDestination target;std::string completedMarker;bool completed=false,originallyAbsent=false;
    enum class State{Initial,Source,Destination,Deciding,Complete,Failed};State state=State::Initial;
    void requireState(State expected,const char* stage){if(state!=expected){state=State::Failed;throw WinError(stage,ERROR_INVALID_DATA);}}
    void publish(MigrationSlot slot,const std::string& bytes){
        check();io.createTemp(slot);check();io.writeTemp(slot,bytes);check();io.flushTemp(slot);check();
        migrationRequire(io.readTemp(slot)==bytes,"migration-temp-readback");check();io.publishTemp(slot);check();io.flushTemp(slot);check();
        migrationRequire(io.readPublished(slot)==bytes,"migration-published-readback");check();
    }
    static std::array<BYTE,32> digest(const std::string& bytes){
        auto hex=migrationHash(bytes);std::array<BYTE,32> result={};auto digit=[](char c){return c<='9'?c-'0':c-'a'+10;};
        for(size_t i=0;i<result.size();++i)result[i]=static_cast<BYTE>(digit(hex[i*2])*16+digit(hex[i*2+1]));return result;
    }
public:
    ObservingMigration(const MigrationContext& expected,ObservingMigrationIo& native,std::function<void()> alive=[]{}):context(expected),io(native),check(std::move(alive)){
        check();const auto saved=io.marker();completedMarker=saved.bytes;completed=saved.present;migrationRequire(completed||completedMarker.empty(),"migration-absent-marker-bytes");
        if(completed)originallyAbsent=migrationMarkerOrigin(completedMarker);
        check();source=io.acquireSource(!completed);migrationSnapshot(source.bytes);
        migrationRequire(lowerHex(widen(source.identity),24)&&(!completed||!source.reserved),"migration-source-identity");
        if(completed)migrationRequire(migrationMarker(context,source,originallyAbsent)==completedMarker,"migration-marker-binding");
        else originallyAbsent=source.reserved;
        check();target=io.destination();if(target.present)migrationSnapshot(target.bytes);else migrationRequire(target.bytes.empty(),"migration-absent-destination");
        migrationRequire(source.bytes.size()+target.bytes.size()<=observingMigrationBytes*2,"migration-total-snapshot-size");check();io.verify(source,target);check();
        if(completed)migrationRequire(target.present,"migration-completed-destination-missing");
    }
    std::vector<BYTE> sourceFrame(){
        requireState(State::Initial,"migration-source-order");check();state=State::Source;
        std::vector<BYTE> bytes{1,static_cast<BYTE>(completed?1:0),static_cast<BYTE>(source.reserved?1:0),0};bytes.insert(bytes.end(),source.bytes.begin(),source.bytes.end());return bytes;
    }
    std::vector<BYTE> destinationFrame(){
        requireState(State::Source,"migration-destination-order");check();state=State::Destination;
        std::vector<BYTE> bytes{1,static_cast<BYTE>(target.present?1:0),0,0};bytes.insert(bytes.end(),target.bytes.begin(),target.bytes.end());return bytes;
    }
    std::vector<BYTE> decide(const std::vector<BYTE>& bytes){
        requireState(State::Destination,"migration-decision-order");state=State::Deciding;
        try{
            check();migrationRequire(bytes.size()==68&&bytes[0]==1&&bytes[1]<=3&&bytes[2]==static_cast<BYTE>(target.present?1:0)&&bytes[3]==0,"migration-decision-fields");
            const auto sourceHash=digest(source.bytes);const auto destinationHash=target.present?digest(target.bytes):std::array<BYTE,32>{};
            migrationRequire(std::equal(sourceHash.begin(),sourceHash.end(),bytes.begin()+4)&&std::equal(destinationHash.begin(),destinationHash.end(),bytes.begin()+36),"migration-decision-hashes");
            check();io.verify(source,target);check();const BYTE action=bytes[1];
            if(action==0)throw WinError("migration-blocked",ERROR_INVALID_DATA);
            if(completed)migrationRequire(action==3&&target.present,"migration-completed-action");
            else if(action==1)migrationRequire(!target.present,"migration-copy-existing");
            else migrationRequire(action==2&&target.present&&target.bytes==source.bytes,"migration-existing-conflict");
            if(action==1){publish(MigrationSlot::Destination,source.bytes);target={source.bytes,true};io.verify(source,target);check();}
            if(!completed)publish(MigrationSlot::Marker,migrationMarker(context,source,originallyAbsent));
            check();io.verify(source,target);check();io.releaseDestination();state=State::Complete;return {1,action};
        }catch(...){state=State::Failed;throw;}
    }
};
class WindowsObservingMigrationIo final:public ObservingMigrationIo {
    Ownership& owned;std::wstring legacyDirectory,sourcePath,destinationPath,importTemp,markerPath,markerTemp;
    std::vector<std::unique_ptr<Pinned>> ancestors;std::unique_ptr<Pinned> legacy,destinationDirectory,target,completion;
    Handle source,pendingImport,pendingMarker;Identity sourceIdentity,importIdentity,markerIdentity;bool sourceAcquired=false;std::string guardedBytes;
    Handle& pending(MigrationSlot slot){return slot==MigrationSlot::Destination?pendingImport:pendingMarker;}
    const std::wstring& tempPath(MigrationSlot slot)const{return slot==MigrationSlot::Destination?importTemp:markerTemp;}
    const std::wstring& publishedPath(MigrationSlot slot)const{return slot==MigrationSlot::Destination?destinationPath:markerPath;}
    Identity& pendingIdentity(MigrationSlot slot){return slot==MigrationSlot::Destination?importIdentity:markerIdentity;}
    void noninherited(HANDLE handle){DWORD flags=0;if(!SetHandleInformation(handle,HANDLE_FLAG_INHERIT,0)||!GetHandleInformation(handle,&flags)||(flags&HANDLE_FLAG_INHERIT))throw WinError("migration-handle-inheritance");}
    void verifyRoots(){owned.verify();for(const auto& pin:ancestors)pin->verify();if(legacy){legacy->verify();requireOwner(legacy->handle.value,owned.owner);}if(destinationDirectory){destinationDirectory->verify();requireOwner(destinationDirectory->handle.value,owned.owner);}}
    void sourceGuard(){
        migrationRequire(sourceAcquired&&identity(source.value,false)==sourceIdentity,"migration-source-identity-changed");finalName(source.value,sourcePath);requireOwner(source.value,owned.owner);noninherited(source.value);
    }
    void createFixed(Handle& file,const std::wstring& path,DWORD extra=0){
        LocalMemory descriptor;auto attributes=privateAttributes(owned.owner,descriptor);
        file.value=CreateFileW(filesystemPath(path).c_str(),GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES|extra,FILE_SHARE_READ,&attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_WRITE_THROUGH,nullptr);
        if(file.value==INVALID_HANDLE_VALUE)throw WinError("migration-create-new");identity(file.value,false);finalName(file.value,path);requireOwner(file.value,owned.owner);noninherited(file.value);
        // Creation-only policy. Never repair an existing migration/source file.
        Pinned policy(path,false,READ_CONTROL|WRITE_DAC|WRITE_OWNER|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
        verifyAcl(policy.handle.value,SE_FILE_OBJECT,owned.owner,nullptr,0,false);label(policy,SECURITY_MANDATORY_MEDIUM_RID,false,true);privatePolicy(policy,owned.owner);
    }
    void renameNew(HANDLE file,const std::wstring& destination){
        verifyRoots();const auto name=filesystemPath(destination);const size_t count=name.size()*sizeof(wchar_t),size=offsetof(FILE_RENAME_INFO,FileName)+count+sizeof(wchar_t);
        migrationRequire(size<=std::numeric_limits<DWORD>::max(),"migration-rename-size");std::vector<BYTE> buffer(size,0);auto rename=reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
        rename->ReplaceIfExists=FALSE;rename->RootDirectory=nullptr;rename->FileNameLength=static_cast<DWORD>(count);std::copy(name.begin(),name.end(),rename->FileName);
        if(!SetFileInformationByHandle(file,FileRenameInfo,rename,static_cast<DWORD>(size)))throw WinError("migration-publish-no-replace");finalName(file,destination);
    }
    void durableBytes(HANDLE file,const std::string& expected){writeFile(file,expected);migrationRequire(readSmall(file,observingMigrationBytes)==expected,"migration-write-readback");}
public:
    explicit WindowsObservingMigrationIo(Ownership& ownership):owned(ownership),legacyDirectory(parentPath(owned.stateRoot)+L"\\observing"),sourcePath(legacyDirectory+L"\\places.json"),
        destinationPath(owned.dataRoot+L"\\observing\\places.json"),importTemp(owned.controlRoot+L"\\observing-import.tmp"),markerPath(owned.controlRoot+L"\\observing-migration.marker"),markerTemp(owned.controlRoot+L"\\observing-migration.tmp"){}
    MigrationMarker marker() override {
        verifyRoots();migrationRequire(!existsStrict(importTemp)&&!existsStrict(markerTemp),"migration-pending-temp");if(!existsStrict(markerPath))return {};
        completion=std::make_unique<Pinned>(markerPath,false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);noninherited(completion->handle.value);privatePolicy(*completion,owned.owner);
        return {readSmall(completion->handle.value,2048),true};
    }
    MigrationSource acquireSource(bool allowReservation) override {
        migrationRequire(!sourceAcquired,"migration-source-reacquire");verifyRoots();
        if(!existsStrict(legacyDirectory)){migrationRequire(allowReservation,"migration-completed-legacy-missing");privateDirectory(legacyDirectory,owned.owner);}
        ancestors=pinAncestors(sourcePath);legacy=std::make_unique<Pinned>(legacyDirectory,true,READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE);noninherited(legacy->handle.value);requireOwner(legacy->handle.value,owned.owner);verifyRoots();
        const bool absent=!existsStrict(sourcePath);
        if(absent){
            migrationRequire(allowReservation,"migration-completed-source-missing");createFixed(source,sourcePath);durableBytes(source.value,migrationEmptyEnvelope());
            // Duplicate before closing the creator: there is no unguarded gap.
            Handle readOnly;if(!DuplicateHandle(GetCurrentProcess(),source.value,GetCurrentProcess(),&readOnly.value,FILE_GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FALSE,0))throw WinError("migration-source-readonly");
            noninherited(readOnly.value);closeHandle(source);source.value=readOnly.value;readOnly.value=nullptr;
        }else{
            source.value=CreateFileW(filesystemPath(sourcePath).c_str(),GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
            if(source.value==INVALID_HANDLE_VALUE)throw WinError("migration-source-guard");noninherited(source.value);
        }
        sourceIdentity=identity(source.value,false);sourceAcquired=true;sourceGuard();guardedBytes=readSmall(source.value,observingMigrationBytes);sourceGuard();return {guardedBytes,idText(sourceIdentity),absent};
    }
    MigrationDestination destination() override {
        verifyRoots();destinationDirectory=std::make_unique<Pinned>(parentPath(destinationPath),true,READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE);noninherited(destinationDirectory->handle.value);requireOwner(destinationDirectory->handle.value,owned.owner);
        if(!existsStrict(destinationPath))return {};
        target=std::make_unique<Pinned>(destinationPath,false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);noninherited(target->handle.value);requireOwner(target->handle.value,owned.owner);return {readSmall(target->handle.value,observingMigrationBytes),true};
    }
    void verify(const MigrationSource& expected,const MigrationDestination& destination) override {
        verifyRoots();sourceGuard();migrationRequire(idText(sourceIdentity)==expected.identity&&readSmall(source.value,observingMigrationBytes)==expected.bytes,"migration-source-changed");
        if(destination.present){migrationRequire(target!=nullptr,"migration-destination-pin-missing");target->verify();requireOwner(target->handle.value,owned.owner);migrationRequire(readSmall(target->handle.value,observingMigrationBytes)==destination.bytes,"migration-destination-changed");}
        else migrationRequire(!target&&!existsStrict(destinationPath),"migration-destination-appeared");
        if(completion){completion->verify();privatePolicy(*completion,owned.owner);}
    }
    void createTemp(MigrationSlot slot) override {
        verifyRoots();sourceGuard();migrationRequire(!pending(slot).value,"migration-temp-reuse");
        migrationRequire(slot==MigrationSlot::Destination?!target&&!existsStrict(destinationPath):!completion&&!existsStrict(markerPath),"migration-publication-exists");
        createFixed(pending(slot),tempPath(slot),DELETE);pendingIdentity(slot)=identity(pending(slot).value,false);
    }
    void writeTemp(MigrationSlot slot,const std::string& bytes) override {
        migrationRequire(!bytes.empty()&&bytes.size()<=(slot==MigrationSlot::Destination?observingMigrationBytes:2048),"migration-temp-body-size");
        migrationRequire(identity(pending(slot).value,false)==pendingIdentity(slot),"migration-temp-identity");finalName(pending(slot).value,tempPath(slot));
        writeAll(pending(slot).value,reinterpret_cast<const BYTE*>(bytes.data()),bytes.size());if(!SetEndOfFile(pending(slot).value))throw WinError("migration-temp-end");
    }
    void flushTemp(MigrationSlot slot) override {if(!FlushFileBuffers(pending(slot).value))throw WinError("migration-temp-flush");}
    std::string readTemp(MigrationSlot slot) override {migrationRequire(identity(pending(slot).value,false)==pendingIdentity(slot),"migration-temp-read-identity");finalName(pending(slot).value,tempPath(slot));return readSmall(pending(slot).value,slot==MigrationSlot::Destination?observingMigrationBytes:2048);}
    void publishTemp(MigrationSlot slot) override {renameNew(pending(slot).value,publishedPath(slot));migrationRequire(identity(pending(slot).value,false)==pendingIdentity(slot),"migration-published-identity");}
    std::string readPublished(MigrationSlot slot) override {
        // Reopen only the fixed final path and compare the published file ID.
        // Any replacement in this interval blocks before marker/worker creation.
        const auto original=pendingIdentity(slot);closeHandle(pending(slot));
        auto pin=std::make_unique<Pinned>(publishedPath(slot),false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ);noninherited(pin->handle.value);requireOwner(pin->handle.value,owned.owner);migrationRequire(pin->id==original,"migration-published-reopen-identity");
        if(slot==MigrationSlot::Marker)privatePolicy(*pin,owned.owner);const auto bytes=readSmall(pin->handle.value,slot==MigrationSlot::Destination?observingMigrationBytes:2048);
        if(slot==MigrationSlot::Destination)target=std::move(pin);else completion=std::move(pin);return bytes;
    }
    void releaseDestination() override {target.reset();destinationDirectory.reset();}
    void verifyGuard(){verifyRoots();sourceGuard();migrationRequire(readSmall(source.value,observingMigrationBytes)==guardedBytes,"migration-guard-changed");}
};
}
