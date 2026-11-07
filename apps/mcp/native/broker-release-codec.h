#pragma once
#include "broker-session-codec.h"

namespace mcp_runtime {
inline constexpr size_t brokerReleaseTargets=13,brokerReleaseFiles=8;
struct BrokerReleaseTarget {
    JournalFileIdentity identity;
    uint64_t bytes=0;
    std::array<uint8_t,32> digest={};
};
struct BrokerReleaseIntent {
    BrokerSessionRecord session;
    JournalFileIdentity sessionFile,intentFile;
    std::array<uint8_t,32> sessionDigest={};
    std::array<BrokerReleaseTarget,brokerReleaseTargets> targets={};
};
struct BrokerReleaseCompletion {
    std::array<uint8_t,32> intentDigest={},sessionDigest={};
    JournalFileIdentity intentFile,control,lease;
    JournalProcess main;
    std::array<uint8_t,16> generation={};
};
template<size_t Size> inline bool releaseNonzero(const std::array<uint8_t,Size>& bytes){
    return std::any_of(bytes.begin(),bytes.end(),[](uint8_t byte){return byte!=0;});
}
inline void validateReleaseIdentity(const JournalFileIdentity& id,uint32_t volume){
    if(!sessionIdentityPresent(id)||id.volume!=volume)throw JournalError("mcp-release-identity");
}
inline void validateBrokerReleaseIntent(const BrokerReleaseIntent& r){
    validateBrokerSession(r.session);
    if(r.session.phase!=SessionPhase::Ready||!releaseNonzero(r.sessionDigest))throw JournalError("mcp-release-context");
    const auto volume=r.session.control.volume;
    validateReleaseIdentity(r.sessionFile,volume);validateReleaseIdentity(r.intentFile,volume);
    std::vector<JournalFileIdentity> seen={r.session.control,r.session.lease,r.sessionFile,r.intentFile};
    for(size_t i=0;i<seen.size();++i)
        for(size_t j=0;j<i;++j)if(journalIdentityEqual(seen[i],seen[j]))throw JournalError("mcp-release-identity");
    for(size_t i=0;i<r.targets.size();++i){
        const auto& target=r.targets[i];validateReleaseIdentity(target.identity,volume);
        for(const auto& prior:seen)if(journalIdentityEqual(prior,target.identity))throw JournalError("mcp-release-identity");
        seen.push_back(target.identity);
        if(i<brokerReleaseFiles){
            if(!target.bytes||target.bytes>128ULL*1024*1024||!releaseNonzero(target.digest))throw JournalError("mcp-release-file");
        }else if(target.bytes||releaseNonzero(target.digest))throw JournalError("mcp-release-directory");
    }
    if(!journalIdentityEqual(r.targets[11].identity,r.session.stage)
       ||!journalIdentityEqual(r.targets[12].identity,r.session.reservation))throw JournalError("mcp-release-root-binding");
}
inline JournalBytes encodeBrokerReleaseIntent(const BrokerReleaseIntent& r,const JournalChecksum& checksum){
    validateBrokerReleaseIntent(r);if(!checksum)throw JournalError("mcp-release-checksum-unavailable");
    JournalBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','R','L','S','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,1024);
    std::copy(r.sessionDigest.begin(),r.sessionDigest.end(),bytes.begin()+16);
    auto id=[&](size_t at,const JournalFileIdentity& value){wirePut32(bytes.data()+at,value.volume);wirePut32(bytes.data()+at+4,value.indexHigh);wirePut32(bytes.data()+at+8,value.indexLow);};
    id(48,r.sessionFile);wirePut32(bytes.data()+60,r.session.main.pid);journalPut64(bytes.data()+64,r.session.main.creationTime);
    std::copy(r.session.generation.begin(),r.session.generation.end(),bytes.begin()+72);
    std::copy(r.session.descriptorDigest.begin(),r.session.descriptorDigest.end(),bytes.begin()+88);
    id(120,r.session.control);id(132,r.session.lease);id(144,r.session.reservation);id(156,r.session.stage);
    std::copy(r.session.packageDigest.begin(),r.session.packageDigest.end(),bytes.begin()+168);
    wirePut32(bytes.data()+232,static_cast<uint32_t>(r.session.ownerSid.size()));
    std::copy(r.session.ownerSid.begin(),r.session.ownerSid.end(),bytes.begin()+236);
    for(size_t i=0;i<r.targets.size();++i)id(432+12*i,r.targets[i].identity);
    for(size_t i=0;i<brokerReleaseFiles;++i){
        journalPut64(bytes.data()+588+8*i,r.targets[i].bytes);
        std::copy(r.targets[i].digest.begin(),r.targets[i].digest.end(),bytes.begin()+652+32*i);
    }
    id(908,r.intentFile);
    const auto digest=checksum(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);return bytes;
}
inline void requireReleaseFormat(const uint8_t* bytes,size_t size,const std::array<uint8_t,8>& magic,const JournalChecksum& checksum){
    if(!bytes||size!=1024||!std::equal(magic.begin(),magic.end(),bytes)||wire32(bytes+8)!=1||wire32(bytes+12)!=1024)
        throw JournalError("mcp-release-format");
    if(!checksum)throw JournalError("mcp-release-checksum-unavailable");
    const auto digest=checksum(bytes,992);
    if(!std::equal(digest.begin(),digest.end(),bytes+992))throw JournalError("mcp-release-checksum");
}
inline BrokerReleaseIntent decodeBrokerReleaseIntent(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    requireReleaseFormat(bytes,size,{'T','M','C','R','L','S','1',0},checksum);
    for(size_t i=428;i<432;++i)if(bytes[i])throw JournalError("mcp-release-reserved");
    for(size_t i=920;i<992;++i)if(bytes[i])throw JournalError("mcp-release-reserved");
    const auto length=wire32(bytes+232);if(length>192)throw JournalError("mcp-release-owner-size");
    for(size_t i=length;i<192;++i)if(bytes[236+i])throw JournalError("mcp-release-owner-padding");
    auto id=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    BrokerReleaseIntent r;r.session.phase=SessionPhase::Ready;r.sessionFile=id(48);r.intentFile=id(908);
    std::copy_n(bytes+16,32,r.sessionDigest.data());r.session.main={wire32(bytes+60),journalRead64(bytes+64)};
    std::copy_n(bytes+72,16,r.session.generation.data());std::copy_n(bytes+88,32,r.session.descriptorDigest.data());
    r.session.control=id(120);r.session.lease=id(132);r.session.reservation=id(144);r.session.stage=id(156);
    r.session.packageDigest.assign(reinterpret_cast<const char*>(bytes+168),64);
    r.session.ownerSid.assign(reinterpret_cast<const char*>(bytes+236),length);
    for(size_t i=0;i<r.targets.size();++i)r.targets[i].identity=id(432+12*i);
    for(size_t i=0;i<brokerReleaseFiles;++i){
        r.targets[i].bytes=journalRead64(bytes+588+8*i);
        std::copy_n(bytes+652+32*i,32,r.targets[i].digest.data());
    }
    validateBrokerReleaseIntent(r);return r;
}
inline void validateBrokerReleaseCompletion(const BrokerReleaseCompletion& r){
    if(!r.main.pid||!r.main.creationTime||!releaseNonzero(r.generation)
       ||!releaseNonzero(r.intentDigest)||!releaseNonzero(r.sessionDigest))throw JournalError("mcp-release-completion-fields");
    const JournalFileIdentity ids[]={r.intentFile,r.control,r.lease};
    for(size_t i=0;i<3;++i){
        validateReleaseIdentity(ids[i],r.control.volume);
        for(size_t j=0;j<i;++j)if(journalIdentityEqual(ids[i],ids[j]))throw JournalError("mcp-release-identity");
    }
}
inline JournalBytes encodeBrokerReleaseCompletion(const BrokerReleaseCompletion& r,const JournalChecksum& checksum){
    validateBrokerReleaseCompletion(r);if(!checksum)throw JournalError("mcp-release-checksum-unavailable");
    JournalBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','R','L','D','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,1024);
    std::copy(r.intentDigest.begin(),r.intentDigest.end(),bytes.begin()+16);
    auto id=[&](size_t at,const JournalFileIdentity& value){wirePut32(bytes.data()+at,value.volume);wirePut32(bytes.data()+at+4,value.indexHigh);wirePut32(bytes.data()+at+8,value.indexLow);};
    id(48,r.intentFile);id(60,r.control);id(72,r.lease);wirePut32(bytes.data()+84,r.main.pid);journalPut64(bytes.data()+88,r.main.creationTime);
    std::copy(r.generation.begin(),r.generation.end(),bytes.begin()+96);std::copy(r.sessionDigest.begin(),r.sessionDigest.end(),bytes.begin()+112);
    const auto digest=checksum(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);return bytes;
}
inline BrokerReleaseCompletion decodeBrokerReleaseCompletion(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    requireReleaseFormat(bytes,size,{'T','M','C','R','L','D','1',0},checksum);
    for(size_t i=144;i<992;++i)if(bytes[i])throw JournalError("mcp-release-reserved");
    auto id=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    BrokerReleaseCompletion r;std::copy_n(bytes+16,32,r.intentDigest.data());r.intentFile=id(48);r.control=id(60);r.lease=id(72);
    r.main={wire32(bytes+84),journalRead64(bytes+88)};std::copy_n(bytes+96,16,r.generation.data());std::copy_n(bytes+112,32,r.sessionDigest.data());
    validateBrokerReleaseCompletion(r);return r;
}
// An immutable intent authorizes only the missing PREFIX of the fixed delete
// order. A hole later in the remaining tree never grants a broader cleanup.
inline size_t brokerReleasePrefix(const std::array<bool,brokerReleaseTargets>& present){
    size_t first=0;while(first<present.size()&&!present[first])++first;
    for(size_t i=first;i<present.size();++i)if(!present[i])throw JournalError("mcp-release-nonprefix");
    return first;
}
}
