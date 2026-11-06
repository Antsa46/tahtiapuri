#pragma once
#include "broker-resources.h"

namespace mcp_runtime {
enum class BrokerPhase:uint32_t { Prepared=0,ProfileCreating=1,ProfileOwned=2,ProcessCreating=3,ProcessRecorded=4,Running=5,Closing=6,Clean=7 };
inline std::array<uint8_t,32> journalDigest(const uint8_t* bytes,size_t size){
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<uint8_t,32> digest={};
    if(size>1024||BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("mcp-journal-sha-open");
    auto status=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0);
    if(status>=0)status=BCryptHashData(hash,const_cast<PUCHAR>(bytes),static_cast<ULONG>(size),0);
    if(status>=0)status=BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0);
    if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);if(status<0)throw WinError("mcp-journal-sha");return digest;
}
// Fixed one-shot ownership journal. Existing files are NEVER opened for write,
// truncated, recovered or bypassed. Later crash recovery must authenticate this
// context and independently prove process/Job exit before making any mutation.
class BrokerJournal {
    BootstrapDirectoryGuard& control;BrokerResources& resources;MainBootstrap bootstrap;
    BootstrapPin file;std::wstring ownerSid,profileSid;
    BrokerPhase phase_=BrokerPhase::Prepared;DWORD workerPid=0;uint64_t workerCreation=0;bool healthy_=true;
    void commit(BrokerPhase next){
        if(!healthy_)throw WinError("mcp-journal-poisoned",ERROR_INVALID_STATE);
        try{
            control.verify();resources.reservationPin->verify();file.verify();requireBootstrapAcl(file.handle.value,control.owner,false);
            std::array<uint8_t,1024> bytes={};constexpr uint8_t magic[8]={'T','M','C','J','R','N','1',0};std::copy_n(magic,8,bytes.data());
            wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,1024);wirePut32(bytes.data()+16,static_cast<uint32_t>(next));
            wirePut32(bytes.data()+24,bootstrap.main.pid);wirePut32(bytes.data()+28,workerPid);put64(bytes.data()+32,bootstrap.main.creationTime);put64(bytes.data()+40,workerCreation);
            std::copy(bootstrap.generation.begin(),bootstrap.generation.end(),bytes.begin()+48);
            // This identity remains available after the stage has been removed.
            wirePut32(bytes.data()+64,stageIdentity.dwVolumeSerialNumber);wirePut32(bytes.data()+68,stageIdentity.nFileIndexHigh);wirePut32(bytes.data()+72,stageIdentity.nFileIndexLow);
            const std::string digest=runtimePackageDigest;if(digest.size()!=64)throw WinError("mcp-journal-package",ERROR_INVALID_DATA);std::copy(digest.begin(),digest.end(),bytes.begin()+80);
            auto field=[&](const std::wstring& text,size_t offset,size_t maximum){if(text.size()>maximum)throw WinError("mcp-journal-sid-size",ERROR_INVALID_DATA);wirePut32(bytes.data()+offset,static_cast<uint32_t>(text.size()));
                for(size_t i=0;i<text.size();++i){if(text[i]>127||text[i]<32)throw WinError("mcp-journal-sid-text",ERROR_INVALID_DATA);bytes[offset+4+i]=static_cast<uint8_t>(text[i]);}};
            field(ownerSid,144,192);field(profileSid,340,160);auto checksum=journalDigest(bytes.data(),992);std::copy(checksum.begin(),checksum.end(),bytes.begin()+992);
            LARGE_INTEGER zero={};DWORD written=0,read=0;
            if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)||!WriteFile(file.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)||written!=bytes.size()||!SetEndOfFile(file.handle.value)||!FlushFileBuffers(file.handle.value))throw WinError("mcp-journal-commit");
            std::array<uint8_t,1024> actual={};if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)||!ReadFile(file.handle.value,actual.data(),static_cast<DWORD>(actual.size()),&read,nullptr)||read!=actual.size()||actual!=bytes)throw WinError("mcp-journal-readback",ERROR_INVALID_DATA);
            const auto info=file.inspect();if(info.nFileSizeHigh||info.nFileSizeLow!=bytes.size())throw WinError("mcp-journal-length",ERROR_INVALID_DATA);
            file.verify();requireBootstrapAcl(file.handle.value,control.owner,false);phase_=next;
        }catch(...){healthy_=false;throw;}
    }
public:
    const BY_HANDLE_FILE_INFORMATION stageIdentity;
    const std::wstring nonce,profileName,jobName;
    BrokerJournal(BootstrapDirectoryGuard& guard,BrokerResources& data,const MainBootstrap& identity)
        :control(guard),resources(data),bootstrap(identity),file(data.reservation+L"\\broker-journal.bin",false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,CREATE_NEW),
         ownerSid(windows_runtime::sidText(guard.owner.sid())),stageIdentity(data.identity()),nonce(hex(identity.generation.data(),identity.generation.size())),profileName(L"tahtiapuri.mcp."+nonce),jobName(L"Global\\Tahtiapuri.Mcp."+nonce){commit(BrokerPhase::Prepared);}
    bool healthy()const{return healthy_;}
    BrokerPhase phase()const{return phase_;}
    void creatingProfile(){if(phase_!=BrokerPhase::Prepared)throw WinError("mcp-profile-order",ERROR_INVALID_STATE);commit(BrokerPhase::ProfileCreating);}
    void ownedProfile(PSID sid){
        if(phase_!=BrokerPhase::ProfileCreating||!sid||!IsValidSid(sid))throw WinError("mcp-profile-owner",ERROR_INVALID_STATE);
        PSID expected=nullptr;const auto result=DeriveAppContainerSidFromAppContainerName(profileName.c_str(),&expected);
        if(FAILED(result))throw WinError("mcp-profile-derive",static_cast<DWORD>(result));const bool same=EqualSid(expected,sid)!=FALSE;FreeSid(expected);
        if(!same)throw WinError("mcp-profile-sid",ERROR_INVALID_SID);profileSid=windows_runtime::sidText(sid);commit(BrokerPhase::ProfileOwned);
    }
    void creatingProcess(){if(phase_!=BrokerPhase::ProfileOwned)throw WinError("mcp-create-order",ERROR_INVALID_STATE);commit(BrokerPhase::ProcessCreating);}
    void recordedProcess(DWORD pid,uint64_t creation){if(phase_!=BrokerPhase::ProcessCreating||!pid||!creation)throw WinError("mcp-process-identity",ERROR_INVALID_DATA);workerPid=pid;workerCreation=creation;commit(BrokerPhase::ProcessRecorded);}
    void requireResume()const{if(!healthy_||phase_!=BrokerPhase::ProcessRecorded)throw WinError("mcp-resume-unrecorded",ERROR_INVALID_STATE);}
    void running(){requireResume();commit(BrokerPhase::Running);}
    void closing(){if(phase_==BrokerPhase::ProfileCreating||phase_==BrokerPhase::ProcessCreating||phase_==BrokerPhase::Clean)throw WinError("mcp-cleanup-ambiguous",ERROR_INVALID_STATE);commit(BrokerPhase::Closing);}
    void clean(){if(phase_!=BrokerPhase::Closing)throw WinError("mcp-clean-order",ERROR_INVALID_STATE);commit(BrokerPhase::Clean);}
};
}
