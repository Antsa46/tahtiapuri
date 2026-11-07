#pragma once
#include "broker-session-store.h"
#include "broker-journal.h"
#include "bootstrap-publication.h"

namespace mcp_runtime {
inline constexpr wchar_t sessionLeaseLeaf[]=L"native-session.lease";
inline constexpr wchar_t sessionRecordLeaf[]=L"native-session.bin";
inline JournalFileIdentity sessionFileIdentity(const BY_HANDLE_FILE_INFORMATION& info){
    return {info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow};
}
inline std::string sessionOwner(const BootstrapOwner& owner){
    const auto sid=windows_runtime::sidText(owner.sid());std::string ascii;
    for(wchar_t letter:sid){
        if(letter<32||letter>127)throw WinError("mcp-session-owner-text",ERROR_INVALID_DATA);
        ascii+=static_cast<char>(letter);
    }
    return ascii;
}
template<size_t Size> std::array<uint8_t,Size> sessionReadBytes(BootstrapPin& file){
    const auto before=file.inspect();
    if(before.nFileSizeHigh||before.nFileSizeLow!=Size)throw WinError("mcp-session-length",ERROR_INVALID_DATA);
    LARGE_INTEGER zero={};DWORD count=0;std::array<uint8_t,Size> bytes={};
    if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)
       ||!ReadFile(file.handle.value,bytes.data(),static_cast<DWORD>(Size),&count,nullptr)||count!=Size)
        throw WinError("mcp-session-read");
    const auto after=file.inspect();
    if(after.nFileSizeHigh||after.nFileSizeLow!=Size)throw WinError("mcp-session-length",ERROR_INVALID_DATA);
    file.verify();return bytes;
}
template<size_t Size> void sessionWriteBytes(BootstrapPin& file,const std::array<uint8_t,Size>& bytes){
    LARGE_INTEGER zero={};DWORD count=0;
    if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)
       ||!WriteFile(file.handle.value,bytes.data(),static_cast<DWORD>(Size),&count,nullptr)||count!=Size
       ||!SetEndOfFile(file.handle.value)||!FlushFileBuffers(file.handle.value))
        throw WinError("mcp-session-write");
    if(sessionReadBytes<Size>(file)!=bytes)throw WinError("mcp-session-readback",ERROR_INVALID_DATA);
}
inline std::array<uint8_t,32> sessionDescriptorDigest(const MainBootstrap& value){
    // decodeMainBootstrap accounts for every one of these 96 bytes, including
    // the reserved zero field. Never persist the ticket itself in the session.
    std::array<uint8_t,bootstrapBytes> bytes={};constexpr uint8_t magic[8]={'T','M','B','O','O','T','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,bootstrapBytes);
    wirePut32(bytes.data()+16,value.main.pid);journalPut64(bytes.data()+24,value.main.creationTime);
    std::copy(value.pipeNonce.begin(),value.pipeNonce.end(),bytes.begin()+32);
    std::copy(value.generation.begin(),value.generation.end(),bytes.begin()+48);
    std::copy(value.launchToken.begin(),value.launchToken.end(),bytes.begin()+64);
    try{const auto digest=journalDigest(bytes.data(),bytes.size());SecureZeroMemory(bytes.data(),bytes.size());return digest;}
    catch(...){SecureZeroMemory(bytes.data(),bytes.size());throw;}
}
inline void requireSessionBudget(uint64_t deadline){
    if(deadline&&GetTickCount64()>=deadline)throw WinError("mcp-session-lease-timeout",ERROR_TIMEOUT);
}
class NativeSessionLease {
    BootstrapDirectoryGuard& control;
    std::unique_ptr<BootstrapPin> file;
public:
    NativeSessionLease(BootstrapDirectoryGuard& guard,bool create,uint64_t deadline=0,const MainBootstrap* main=nullptr):control(guard){
        const auto path=control.root+L"\\"+sessionLeaseLeaf;
        for(;;){
            requireSessionBudget(deadline);
            try{
                // A real data-access handle with share=0 is the native mutex.
                // Directory/metadata pins alone are not a sharing-based lock.
                file=std::make_unique<BootstrapPin>(path,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,create?CREATE_NEW:OPEN_EXISTING,0);
                break;
            }catch(const WinError& e){
                if(create||e.code!=ERROR_SHARING_VIOLATION||!deadline)throw WinError("mcp-session-lease-open",e.code);
                requireSessionBudget(deadline);
                if(main)requirePublishingMain(*main);
                Sleep(2);
            }
        }
        control.verify();requireBootstrapAcl(file->handle.value,control.owner,false);
        // A pre-existing lease, even with no session record, is never repaired.
        if(create)sessionWriteBytes(*file,brokerLeaseHeader());
        verify();requireSessionBudget(deadline);
    }
    const BY_HANDLE_FILE_INFORMATION& identity()const{return file->initial;}
    void verify(){
        if(!file)throw WinError("mcp-session-lease-closed",ERROR_INVALID_STATE);
        control.verify();file->verify();requireBootstrapAcl(file->handle.value,control.owner,false);
        if(sessionReadBytes<32>(*file)!=brokerLeaseHeader())throw WinError("mcp-session-lease-header",ERROR_INVALID_DATA);
    }
    void close(){verify();closeBootstrapHandle(*file);file.reset();}
};
class NativeSessionFile final:private BrokerJournalStorage {
    BootstrapDirectoryGuard& control;NativeSessionLease& lease;
    std::unique_ptr<BootstrapPin> file;BrokerSessionStore store;
    void write(const JournalBytes& bytes)override{
        LARGE_INTEGER zero={};DWORD count=0;
        if(!SetFilePointerEx(file->handle.value,zero,nullptr,FILE_BEGIN)
           ||!WriteFile(file->handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)
           ||count!=bytes.size()||!SetEndOfFile(file->handle.value))throw WinError("mcp-session-write");
    }
    void flush()override{if(!FlushFileBuffers(file->handle.value))throw WinError("mcp-session-flush");}
    JournalBytes read()override{return sessionReadBytes<1024>(*file);}
public:
    NativeSessionFile(BootstrapDirectoryGuard& guard,NativeSessionLease& lock,bool create):control(guard),lease(lock),
        file(std::make_unique<BootstrapPin>(guard.root+L"\\"+sessionRecordLeaf,false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,create?CREATE_NEW:OPEN_EXISTING,0)),
        store(*this,journalDigest){verify();}
    void verify()override{
        // Native-only identity/ACL checks. Never delegate back to store.load().
        if(!file||!store.healthy())throw WinError("mcp-session-poisoned",ERROR_INVALID_STATE);
        control.verify();lease.verify();file->verify();requireBootstrapAcl(file->handle.value,control.owner,false);
    }
    BrokerSessionRecord load(){return store.load();}
    void commit(const BrokerSessionRecord& value){store.commit(value);}
    void close(){verify();closeBootstrapHandle(*file);file.reset();}
};
inline void requireSessionContext(const BrokerSessionRecord& record,BootstrapDirectoryGuard& control,NativeSessionLease& lease,const MainBootstrap& expected){
    control.verify();lease.verify();
    if(record.main.pid!=expected.main.pid||record.main.creationTime!=expected.main.creationTime||record.generation!=expected.generation
       ||record.descriptorDigest!=sessionDescriptorDigest(expected)||record.packageDigest!=runtimePackageDigest||record.ownerSid!=sessionOwner(control.owner)
       ||!journalIdentityEqual(record.control,sessionFileIdentity(control.directory->initial))
       ||!journalIdentityEqual(record.lease,sessionFileIdentity(lease.identity())))
        throw WinError("mcp-session-context",ERROR_ACCESS_DENIED);
}
inline void requireSessionReservation(const BrokerSessionRecord& record,BootstrapDirectoryGuard& control,bool stage){
    BootstrapPin reservation(control.root+L"\\native-session-reserved",true,READ_CONTROL|FILE_READ_ATTRIBUTES);
    resourceAcl(reservation,control.owner,nullptr,0,true,false,true);
    if(!journalIdentityEqual(record.reservation,sessionFileIdentity(reservation.initial)))throw WinError("mcp-session-reservation",ERROR_ACCESS_DENIED);
    if(stage){
        BootstrapPin worker(reservation.path+L"\\worker",true,READ_CONTROL|FILE_READ_ATTRIBUTES);
        resourceAcl(worker,control.owner,nullptr,0,true,false,true);
        if(!journalIdentityEqual(record.stage,sessionFileIdentity(worker.initial)))throw WinError("mcp-session-stage",ERROR_ACCESS_DENIED);
    }
}
inline void prepareBrokerSession(const std::wstring& path,const MainBootstrap& bootstrap){
    requirePublishingMain(bootstrap);BootstrapDirectoryGuard control(path);
    NativeSessionLease lease(control,true);
    exactChildren(control.root,{sessionLeaseLeaf,L"native-session-reserved"});
    BootstrapPin reservation(control.root+L"\\native-session-reserved",true,READ_CONTROL|FILE_READ_ATTRIBUTES);
    resourceAcl(reservation,control.owner,nullptr,0,true,false,true);exactChildren(reservation.path,{});
    BrokerSessionRecord record;record.main={bootstrap.main.pid,bootstrap.main.creationTime};record.generation=bootstrap.generation;
    record.descriptorDigest=sessionDescriptorDigest(bootstrap);record.packageDigest=runtimePackageDigest;record.ownerSid=sessionOwner(control.owner);
    record.control=sessionFileIdentity(control.directory->initial);record.reservation=sessionFileIdentity(reservation.initial);record.lease=sessionFileIdentity(lease.identity());
    {
        NativeSessionFile state(control,lease,true);state.commit(record);requirePublishingMain(bootstrap);reservation.verify();state.close();
    }
    lease.close();
}
inline void sealBrokerSession(const std::wstring& path,const MainBootstrap& bootstrap){
    requirePublishingMain(bootstrap);BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,false);
    {
        NativeSessionFile state(control,lease,false);auto record=state.load();requireSessionContext(record,control,lease,bootstrap);
        if(record.phase!=SessionPhase::Preparing)throw WinError("mcp-session-seal-order",ERROR_INVALID_STATE);
        exactChildren(control.root,{sessionLeaseLeaf,sessionRecordLeaf,L"native-session-reserved"});requireSessionReservation(record,control,false);
        {
            // Constructor verifies only: no grant, profile, Job, worker or delete.
            BrokerResources resources(control);
            if(!journalIdentityEqual(record.reservation,sessionFileIdentity(resources.reservationPin->initial)))
                throw WinError("mcp-session-reservation",ERROR_ACCESS_DENIED);
            record.stage=sessionFileIdentity(resources.identity());record.phase=SessionPhase::Ready;
            state.commit(record);requirePublishingMain(bootstrap);resources.reservationPin->verify();
        }
        state.close();
    }
    lease.close();
}
inline void publishBrokerSession(const std::wstring& path,const std::array<uint8_t,bootstrapBytes>& bytes,const std::function<void()>& afterDescriptorClose={}){
    const auto bootstrap=decodeMainBootstrap(bytes.data(),bytes.size());requirePublishingMain(bootstrap);
    BootstrapDirectoryGuard control(path);NativeSessionLease lease(control,false);
    {
        NativeSessionFile state(control,lease,false);const auto record=state.load();requireSessionContext(record,control,lease,bootstrap);
        if(record.phase!=SessionPhase::Ready)throw WinError("mcp-session-publish-order",ERROR_INVALID_STATE);
        exactChildren(control.root,{sessionLeaseLeaf,sessionRecordLeaf,L"native-session-reserved"});requireSessionReservation(record,control,true);
        // Lease spans rename, descriptor readback and descriptor handle close.
        // The broker may wait for this lease; generic consume never takes it.
        publishMainBootstrap(path,bytes);
        // Internal C++ dependency seam only. Production CLI never supplies it.
        // Throwing or interruption preserves the published descriptor/session.
        if(afterDescriptorClose)afterDescriptorClose();
        requirePublishingMain(bootstrap);state.close();
    }
    lease.close();
}
class BrokerSessionAdmission {
    BootstrapDirectoryGuard& control;
    std::unique_ptr<NativeSessionLease> lease;
    std::unique_ptr<NativeSessionFile> file;
    BrokerSessionRecord record;
public:
    BrokerSessionAdmission(BootstrapDirectoryGuard& guard,const MainBootstrap& bootstrap,uint64_t startupDeadline):control(guard){
        requirePublishingMain(bootstrap);
        const auto admissionDeadline=std::min(startupDeadline,GetTickCount64()+5000);
        lease=std::make_unique<NativeSessionLease>(control,false,admissionDeadline,&bootstrap);
        file=std::make_unique<NativeSessionFile>(control,*lease,false);record=file->load();requireSessionContext(record,control,*lease,bootstrap);
        if(record.phase!=SessionPhase::Ready)throw WinError("mcp-session-admission-order",ERROR_INVALID_STATE);
        requireSessionReservation(record,control,true);requirePublishingMain(bootstrap);
        record.phase=SessionPhase::BrokerAdmitted;
        record.broker={GetCurrentProcessId(),windows_runtime::windowsProcessWitnessApi().creationTime(GetCurrentProcess())};
        requireSessionBudget(admissionDeadline);file->commit(record);requireSessionBudget(admissionDeadline);
        requirePublishingMain(bootstrap);verify();requireSessionBudget(admissionDeadline);
        // No HELLO, journal, Job or profile precedes the durable admission.
    }
    ~BrokerSessionAdmission(){file.reset();lease.reset();}
    void verify(){
        file->verify();const auto actual=file->load();
        if(encodeBrokerSession(actual,journalDigest)!=encodeBrokerSession(record,journalDigest))
            throw WinError("mcp-session-admission-changed",ERROR_ACCESS_DENIED);
    }
    void bindResources(const BrokerResources& resources){
        verify();
        if(!journalIdentityEqual(record.reservation,sessionFileIdentity(resources.reservationPin->initial))
           ||!journalIdentityEqual(record.stage,sessionFileIdentity(resources.identity())))
            throw WinError("mcp-session-resource-binding",ERROR_ACCESS_DENIED);
    }
    // Caller first closes worker/process/Job, journal, resources and Main peer.
    // Lease availability is never an independent broker-exit proof.
    void close(){file->close();file.reset();lease->close();lease.reset();}
};
}
