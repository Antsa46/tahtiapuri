#pragma once
#include "broker-journal-codec.h"

namespace mcp_runtime {
enum class SessionPhase:uint32_t { Preparing=0,Ready=1,BrokerAdmitted=2 };
struct BrokerSessionRecord {
    SessionPhase phase=SessionPhase::Preparing;
    JournalProcess main,broker;
    std::array<uint8_t,16> generation={};
    std::array<uint8_t,32> descriptorDigest={};
    JournalFileIdentity control,reservation,stage,lease;
    std::string packageDigest,ownerSid;
};
inline bool sessionIdentityPresent(const JournalFileIdentity& id){return id.indexHigh||id.indexLow;}
inline bool sessionIdentityEmpty(const JournalFileIdentity& id){return !id.volume&&!id.indexHigh&&!id.indexLow;}
inline void validateBrokerSession(const BrokerSessionRecord& r){
    const auto phase=static_cast<uint32_t>(r.phase);
    if(phase>2||!r.main.pid||!r.main.creationTime||!journalHashText(r.packageDigest)||!journalSidText(r.ownerSid,192)
       ||std::all_of(r.generation.begin(),r.generation.end(),[](uint8_t b){return b==0;})
       ||std::all_of(r.descriptorDigest.begin(),r.descriptorDigest.end(),[](uint8_t b){return b==0;}))
        throw JournalError("mcp-session-fields");
    const JournalFileIdentity ids[]={r.control,r.reservation,r.lease};
    for(size_t i=0;i<3;++i){
        if(!sessionIdentityPresent(ids[i])||ids[i].volume!=r.control.volume)throw JournalError("mcp-session-identity");
        for(size_t j=0;j<i;++j)if(journalIdentityEqual(ids[i],ids[j]))throw JournalError("mcp-session-identity");
    }
    if(phase==0){
        if(!sessionIdentityEmpty(r.stage))throw JournalError("mcp-session-stage");
    }else{
        if(!sessionIdentityPresent(r.stage)||r.stage.volume!=r.control.volume)throw JournalError("mcp-session-stage");
        for(const auto& id:ids)if(journalIdentityEqual(id,r.stage))throw JournalError("mcp-session-stage");
    }
    if(phase==2){
        if(!r.broker.pid||!r.broker.creationTime||r.broker.pid==r.main.pid)throw JournalError("mcp-session-broker");
    }else if(r.broker.pid||r.broker.creationTime)throw JournalError("mcp-session-broker");
}
inline JournalBytes encodeBrokerSession(const BrokerSessionRecord& r,const JournalChecksum& checksum){
    validateBrokerSession(r);if(!checksum)throw JournalError("mcp-session-checksum-unavailable");
    JournalBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','S','E','S','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,1024);
    wirePut32(bytes.data()+16,static_cast<uint32_t>(r.phase));wirePut32(bytes.data()+20,r.main.pid);journalPut64(bytes.data()+24,r.main.creationTime);
    std::copy(r.generation.begin(),r.generation.end(),bytes.begin()+32);
    auto file=[&](const JournalFileIdentity& id,size_t at){wirePut32(bytes.data()+at,id.volume);wirePut32(bytes.data()+at+4,id.indexHigh);wirePut32(bytes.data()+at+8,id.indexLow);};
    file(r.control,48);file(r.reservation,60);file(r.stage,72);file(r.lease,84);
    wirePut32(bytes.data()+96,r.broker.pid);journalPut64(bytes.data()+104,r.broker.creationTime);
    std::copy(r.packageDigest.begin(),r.packageDigest.end(),bytes.begin()+112);
    wirePut32(bytes.data()+176,static_cast<uint32_t>(r.ownerSid.size()));
    std::copy(r.ownerSid.begin(),r.ownerSid.end(),bytes.begin()+180);
    std::copy(r.descriptorDigest.begin(),r.descriptorDigest.end(),bytes.begin()+384);
    const auto digest=checksum(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);return bytes;
}
inline BrokerSessionRecord decodeBrokerSession(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    constexpr uint8_t magic[8]={'T','M','C','S','E','S','1',0};
    if(!bytes||size!=1024||!std::equal(magic,magic+8,bytes)||wire32(bytes+8)!=1||wire32(bytes+12)!=1024)
        throw JournalError("mcp-session-format");
    if(!checksum)throw JournalError("mcp-session-checksum-unavailable");
    const auto digest=checksum(bytes,992);
    if(!std::equal(digest.begin(),digest.end(),bytes+992))throw JournalError("mcp-session-checksum");
    for(size_t i=100;i<104;++i)if(bytes[i])throw JournalError("mcp-session-reserved");
    for(size_t i=372;i<384;++i)if(bytes[i])throw JournalError("mcp-session-reserved");
    for(size_t i=416;i<992;++i)if(bytes[i])throw JournalError("mcp-session-reserved");
    const auto length=wire32(bytes+176);if(length>192)throw JournalError("mcp-session-owner-size");
    for(size_t i=length;i<192;++i)if(bytes[180+i])throw JournalError("mcp-session-owner-padding");
    BrokerSessionRecord r;r.phase=static_cast<SessionPhase>(wire32(bytes+16));r.main={wire32(bytes+20),journalRead64(bytes+24)};
    std::copy_n(bytes+32,16,r.generation.data());std::copy_n(bytes+384,32,r.descriptorDigest.data());
    auto file=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    r.control=file(48);r.reservation=file(60);r.stage=file(72);r.lease=file(84);r.broker={wire32(bytes+96),journalRead64(bytes+104)};
    r.packageDigest.assign(reinterpret_cast<const char*>(bytes+112),64);r.ownerSid.assign(reinterpret_cast<const char*>(bytes+180),length);
    validateBrokerSession(r);return r;
}
inline std::array<uint8_t,32> brokerLeaseHeader(){
    std::array<uint8_t,32> bytes={};constexpr uint8_t magic[8]={'T','M','C','L','E','A','S','1'};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,32);return bytes;
}
}
