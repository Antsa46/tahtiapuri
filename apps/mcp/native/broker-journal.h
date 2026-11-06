#pragma once
#include "broker-resources.h"
#include "broker-journal-store.h"
#include "../../../packages/windows-runtime/native/process-witness.h"

namespace mcp_runtime {
inline std::array<uint8_t,32> journalDigest(const uint8_t* bytes,size_t size){
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::array<uint8_t,32> digest={};
    if(size>1024||BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("mcp-journal-sha-open");
    auto status=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0);
    if(status>=0)status=BCryptHashData(hash,const_cast<PUCHAR>(bytes),static_cast<ULONG>(size),0);
    if(status>=0)status=BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0);
    if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);if(status<0)throw WinError("mcp-journal-sha");return digest;
}
// This active writer is CREATE_NEW only. Separate release/recovery owners must
// authenticate v2 context and observe fresh OS state before any later mutation.
class BrokerJournal final:private BrokerJournalStorage {
    BootstrapDirectoryGuard& control;BrokerResources& resources;MainBootstrap bootstrap;
    BootstrapPin file;std::wstring ownerSid,profileSid;
    BrokerPhase phase_=BrokerPhase::Prepared;DWORD workerPid=0;uint64_t workerCreation=0;bool healthy_=true;
    BrokerJournalCommitter writer;
    void verify()override{
        control.verify();resources.reservationPin->verify();file.verify();requireBootstrapAcl(file.handle.value,control.owner,false);
    }
    void write(const JournalBytes& bytes)override{
        LARGE_INTEGER zero={};DWORD count=0;
        if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)||!WriteFile(file.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)
           ||count!=bytes.size()||!SetEndOfFile(file.handle.value))throw WinError("mcp-journal-write");
    }
    void flush()override{if(!FlushFileBuffers(file.handle.value))throw WinError("mcp-journal-flush");}
    JournalBytes read()override{
        LARGE_INTEGER zero={};DWORD count=0;JournalBytes bytes={};
        if(!SetFilePointerEx(file.handle.value,zero,nullptr,FILE_BEGIN)||!ReadFile(file.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)
           ||count!=bytes.size())throw WinError("mcp-journal-readback");
        const auto info=file.inspect();if(info.nFileSizeHigh||info.nFileSizeLow!=bytes.size())throw WinError("mcp-journal-length",ERROR_INVALID_DATA);
        return bytes;
    }
    static std::string asciiSid(const std::wstring& value){
        std::string text;for(wchar_t c:value){if(c<32||c>127)throw WinError("mcp-journal-sid-text",ERROR_INVALID_DATA);text+=static_cast<char>(c);}return text;
    }
    static JournalFileIdentity fileIdentity(const BY_HANDLE_FILE_INFORMATION& info){return {info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow};}
    void commit(BrokerPhase next){
        if(!healthy())throw WinError("mcp-journal-poisoned",ERROR_INVALID_STATE);
        try{
            BrokerJournalRecord record;record.phase=next;record.main={bootstrap.main.pid,bootstrap.main.creationTime};
            record.broker={brokerIdentity.pid,brokerIdentity.creationTime};record.worker={workerPid,workerCreation};record.generation=bootstrap.generation;
            record.stage=fileIdentity(stageIdentity);record.reservation=fileIdentity(reservationIdentity);
            record.packageDigest=runtimePackageDigest;record.ownerSid=asciiSid(ownerSid);record.profileSid=asciiSid(profileSid);
            writer.commit(record);phase_=next;
        }catch(...){healthy_=false;throw;}
    }
public:
    const BY_HANDLE_FILE_INFORMATION stageIdentity,reservationIdentity;
    const MainIdentity brokerIdentity;
    const std::wstring nonce,profileName,jobName;
    BrokerJournal(BootstrapDirectoryGuard& guard,BrokerResources& data,const MainBootstrap& identity)
        :control(guard),resources(data),bootstrap(identity),file(data.reservation+L"\\broker-journal.bin",false,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES,CREATE_NEW),
         ownerSid(windows_runtime::sidText(guard.owner.sid())),writer(*this,journalDigest),stageIdentity(data.identity()),reservationIdentity(data.reservationPin->initial),
         brokerIdentity{GetCurrentProcessId(),windows_runtime::windowsProcessWitnessApi().creationTime(GetCurrentProcess())},
         nonce(hex(identity.generation.data(),identity.generation.size())),profileName(L"tahtiapuri.mcp."+nonce),jobName(L"Global\\Tahtiapuri.Mcp."+nonce){commit(BrokerPhase::Prepared);}
    bool healthy()const{return healthy_&&writer.healthy();}
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
    void requireResume()const{if(!healthy()||phase_!=BrokerPhase::ProcessRecorded)throw WinError("mcp-resume-unrecorded",ERROR_INVALID_STATE);}
    void running(){requireResume();commit(BrokerPhase::Running);}
    void closing(){if(phase_==BrokerPhase::ProfileCreating||phase_==BrokerPhase::ProcessCreating||phase_==BrokerPhase::Clean)throw WinError("mcp-cleanup-ambiguous",ERROR_INVALID_STATE);commit(BrokerPhase::Closing);}
    void clean(){if(phase_!=BrokerPhase::Closing)throw WinError("mcp-clean-order",ERROR_INVALID_STATE);commit(BrokerPhase::Clean);}
};
}
