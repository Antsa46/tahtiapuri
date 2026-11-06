#pragma once
#include "broker-wire.h"
#include <string>

namespace mcp_runtime {
inline constexpr size_t brokerJournalBytes=1024,brokerJournalPayloadBytes=992;
using JournalBytes=std::array<uint8_t,brokerJournalBytes>;
using JournalChecksum=std::function<std::array<uint8_t,32>(const uint8_t*,size_t)>;
struct JournalError:std::runtime_error{explicit JournalError(const char* reason):std::runtime_error(reason){}};
enum class BrokerPhase:uint32_t { Prepared=0,ProfileCreating=1,ProfileOwned=2,ProcessCreating=3,ProcessRecorded=4,Running=5,Closing=6,Clean=7 };
struct JournalProcess {uint32_t pid=0;uint64_t creationTime=0;};
struct JournalFileIdentity {uint32_t volume=0,indexHigh=0,indexLow=0;};
struct BrokerJournalRecord {
    BrokerPhase phase=BrokerPhase::Prepared;
    JournalProcess main,broker,worker;
    std::array<uint8_t,16> generation={};
    JournalFileIdentity stage,reservation;
    std::string packageDigest,ownerSid,profileSid;
};
inline uint64_t journalRead64(const uint8_t* bytes){uint64_t n=0;for(unsigned i=0;i<8;++i)n|=uint64_t(bytes[i])<<(8*i);return n;}
inline void journalPut64(uint8_t* bytes,uint64_t n){for(unsigned i=0;i<8;++i)bytes[i]=uint8_t(n>>(8*i));}
inline bool journalHashText(const std::string& text){return text.size()==64&&std::all_of(text.begin(),text.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});}
inline bool journalSidText(const std::string& text,size_t maximum){
    if(text.empty()||text.size()>maximum||text.compare(0,4,"S-1-")!=0)return false;
    size_t begin=4,parts=0;
    while(begin<text.size()){
        const auto found=text.find('-',begin),end=found==std::string::npos?text.size():found;
        if(begin==end||(end-begin>1&&text[begin]=='0'))return false;
        const uint64_t limit=parts?UINT64_C(4294967295):UINT64_C(281474976710655);uint64_t value=0;
        for(size_t i=begin;i<end;++i){if(text[i]<'0'||text[i]>'9')return false;const auto digit=uint64_t(text[i]-'0');if(value>(limit-digit)/10)return false;value=value*10+digit;}
        if(++parts>16)return false;
        if(found==std::string::npos)return parts>=2;
        begin=end+1;
    }
    return false;
}
inline bool journalIdentityEqual(const JournalFileIdentity& a,const JournalFileIdentity& b){return a.volume==b.volume&&a.indexHigh==b.indexHigh&&a.indexLow==b.indexLow;}
inline void validateBrokerJournalRecord(const BrokerJournalRecord& record){
    const auto phase=static_cast<uint32_t>(record.phase);
    if(phase>7||!record.main.pid||!record.main.creationTime||!record.broker.pid||!record.broker.creationTime
       ||bool(record.worker.pid)!=bool(record.worker.creationTime)||!journalHashText(record.packageDigest)||!journalSidText(record.ownerSid,192)
       ||(!record.profileSid.empty()&&!journalSidText(record.profileSid,160)))throw JournalError("mcp-journal-fields");
    if((!record.stage.indexHigh&&!record.stage.indexLow)||(!record.reservation.indexHigh&&!record.reservation.indexLow)
       ||record.stage.volume!=record.reservation.volume||journalIdentityEqual(record.stage,record.reservation))throw JournalError("mcp-journal-file-identity");
    const bool worker=record.worker.pid!=0,profile=!record.profileSid.empty();
    if((worker&&!profile)||((phase==0||phase==1)&&(profile||worker))||((phase==2||phase==3)&&(!profile||worker))
       ||((phase==4||phase==5)&&(!profile||!worker)))throw JournalError("mcp-journal-phase-fields");
}
inline JournalBytes encodeBrokerJournal(const BrokerJournalRecord& record,const JournalChecksum& checksum){
    validateBrokerJournalRecord(record);if(!checksum)throw JournalError("mcp-journal-checksum-unavailable");
    JournalBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','J','R','N','2',0};std::copy_n(magic,8,bytes.data());
    wirePut32(bytes.data()+8,2);wirePut32(bytes.data()+12,static_cast<uint32_t>(brokerJournalBytes));wirePut32(bytes.data()+16,static_cast<uint32_t>(record.phase));
    wirePut32(bytes.data()+20,record.broker.pid);wirePut32(bytes.data()+24,record.main.pid);wirePut32(bytes.data()+28,record.worker.pid);
    journalPut64(bytes.data()+32,record.main.creationTime);journalPut64(bytes.data()+40,record.worker.creationTime);
    std::copy(record.generation.begin(),record.generation.end(),bytes.begin()+48);
    auto file=[&](const JournalFileIdentity& id,size_t at){wirePut32(bytes.data()+at,id.volume);wirePut32(bytes.data()+at+4,id.indexHigh);wirePut32(bytes.data()+at+8,id.indexLow);};
    file(record.stage,64);std::copy(record.packageDigest.begin(),record.packageDigest.end(),bytes.begin()+80);
    auto sid=[&](const std::string& text,size_t at){wirePut32(bytes.data()+at,static_cast<uint32_t>(text.size()));for(size_t i=0;i<text.size();++i)bytes[at+4+i]=static_cast<uint8_t>(text[i]);};
    sid(record.ownerSid,144);sid(record.profileSid,340);journalPut64(bytes.data()+504,record.broker.creationTime);file(record.reservation,512);
    const auto digest=checksum(bytes.data(),brokerJournalPayloadBytes);std::copy(digest.begin(),digest.end(),bytes.begin()+brokerJournalPayloadBytes);return bytes;
}
inline BrokerJournalRecord decodeBrokerJournal(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    constexpr uint8_t magic[8]={'T','M','C','J','R','N','2',0};
    if(!bytes||size!=brokerJournalBytes||!std::equal(magic,magic+8,bytes)||wire32(bytes+8)!=2||wire32(bytes+12)!=brokerJournalBytes)throw JournalError("mcp-journal-format");
    if(!checksum)throw JournalError("mcp-journal-checksum-unavailable");
    const auto digest=checksum(bytes,brokerJournalPayloadBytes);
    if(!std::equal(digest.begin(),digest.end(),bytes+brokerJournalPayloadBytes))throw JournalError("mcp-journal-checksum");
    for(size_t i=76;i<80;++i)if(bytes[i])throw JournalError("mcp-journal-reserved");
    for(size_t i=524;i<brokerJournalPayloadBytes;++i)if(bytes[i])throw JournalError("mcp-journal-reserved");
    BrokerJournalRecord record;record.phase=static_cast<BrokerPhase>(wire32(bytes+16));
    record.main={wire32(bytes+24),journalRead64(bytes+32)};record.worker={wire32(bytes+28),journalRead64(bytes+40)};record.broker={wire32(bytes+20),journalRead64(bytes+504)};
    std::copy_n(bytes+48,16,record.generation.data());
    auto file=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    record.stage=file(64);record.reservation=file(512);record.packageDigest.assign(reinterpret_cast<const char*>(bytes+80),64);
    auto sid=[&](size_t at,size_t maximum){
        const auto length=wire32(bytes+at);if(length>maximum)throw JournalError("mcp-journal-sid-size");
        for(size_t i=length;i<maximum;++i)if(bytes[at+4+i])throw JournalError("mcp-journal-sid-padding");
        return std::string(reinterpret_cast<const char*>(bytes+at+4),length);
    };
    record.ownerSid=sid(144,192);record.profileSid=sid(340,160);validateBrokerJournalRecord(record);return record;
}
}
