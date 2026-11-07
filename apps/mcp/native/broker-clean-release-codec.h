#pragma once
#include "broker-release-codec.h"

namespace mcp_runtime {
inline constexpr size_t brokerCleanIntentBytes=2048,brokerCleanIntentPayload=2016;
inline constexpr size_t brokerCleanSessionPrefix=416,brokerCleanJournalOffset=992;
inline constexpr uint32_t brokerCleanWitnessPolicy=1;
using CleanIntentBytes=std::array<uint8_t,brokerCleanIntentBytes>;
// Policy1 retires an admitted generation only after fresh process/Job/stage
// checks. JournalClean reports the producer's successful profile-delete call;
// this record never claims independent physical profile/storage absence.
struct BrokerCleanReleaseIntent {
    BrokerSessionRecord session;
    BrokerJournalRecord journal;
    JournalFileIdentity sessionFile,journalFile,intentFile;
    std::array<uint8_t,32> sessionDigest={},journalDigest={};
};
struct BrokerCleanReleaseCompletion {
    BrokerReleaseCompletion owner;
    JournalFileIdentity journalFile;
    std::array<uint8_t,32> journalDigest={};
};
inline bool cleanReleaseProcessEqual(const JournalProcess& a,const JournalProcess& b){return a.pid==b.pid&&a.creationTime==b.creationTime;}
inline void validateBrokerCleanReleaseSource(const BrokerCleanReleaseIntent& r){
    validateBrokerSession(r.session);validateBrokerJournalRecord(r.journal);
    if(r.session.phase!=SessionPhase::BrokerAdmitted||r.journal.phase!=BrokerPhase::Clean
       ||!r.journal.worker.pid||!r.journal.worker.creationTime||r.journal.profileSid.empty()
       ||r.journal.worker.pid==r.session.main.pid||r.journal.worker.pid==r.session.broker.pid
       ||!cleanReleaseProcessEqual(r.session.main,r.journal.main)||!cleanReleaseProcessEqual(r.session.broker,r.journal.broker)
       ||r.session.generation!=r.journal.generation||r.session.packageDigest!=r.journal.packageDigest||r.session.ownerSid!=r.journal.ownerSid
       ||!journalIdentityEqual(r.session.stage,r.journal.stage)||!journalIdentityEqual(r.session.reservation,r.journal.reservation))
        throw JournalError("mcp-clean-release-context");
    if(!releaseNonzero(r.sessionDigest)||!releaseNonzero(r.journalDigest))throw JournalError("mcp-clean-release-digest");
    const JournalFileIdentity ids[]={r.session.control,r.session.lease,r.session.reservation,r.session.stage,r.sessionFile,r.journalFile};
    for(size_t i=0;i<6;++i){
        if(!sessionIdentityPresent(ids[i])||ids[i].volume!=r.session.control.volume)throw JournalError("mcp-clean-release-identity");
        for(size_t j=0;j<i;++j)if(journalIdentityEqual(ids[i],ids[j]))throw JournalError("mcp-clean-release-identity");
    }
}
inline void validateBrokerCleanReleaseIntent(const BrokerCleanReleaseIntent& r){
    validateBrokerCleanReleaseSource(r);
    if(!sessionIdentityPresent(r.intentFile)||r.intentFile.volume!=r.session.control.volume)throw JournalError("mcp-clean-release-identity");
    for(const auto& id:{r.session.control,r.session.lease,r.session.reservation,r.session.stage,r.sessionFile,r.journalFile})
        if(journalIdentityEqual(id,r.intentFile))throw JournalError("mcp-clean-release-identity");
}
inline CleanIntentBytes encodeBrokerCleanReleaseIntent(const BrokerCleanReleaseIntent& r,const JournalChecksum& checksum){
    validateBrokerCleanReleaseIntent(r);if(!checksum)throw JournalError("mcp-clean-release-checksum-unavailable");
    const auto session=encodeBrokerSession(r.session,checksum),journal=encodeBrokerJournal(r.journal,checksum);
    if(checksum(session.data(),session.size())!=r.sessionDigest)throw JournalError("mcp-clean-release-session-digest");
    if(checksum(journal.data(),journal.size())!=r.journalDigest)throw JournalError("mcp-clean-release-journal-digest");
    CleanIntentBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','C','L','S','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,brokerCleanIntentBytes);
    wirePut32(bytes.data()+16,brokerCleanWitnessPolicy);
    // Session-v1 defines only its first416 bytes and a checksum. Its remaining
    // payload must be zero, so this prefix reconstructs the full canonical1024
    // bytes without omitting any accepted source field. Journal-v2 is kept whole.
    std::copy_n(session.data(),brokerCleanSessionPrefix,bytes.data()+32);
    std::copy(r.sessionDigest.begin(),r.sessionDigest.end(),bytes.begin()+448);
    auto id=[&](size_t at,const JournalFileIdentity& value){wirePut32(bytes.data()+at,value.volume);wirePut32(bytes.data()+at+4,value.indexHigh);wirePut32(bytes.data()+at+8,value.indexLow);};
    id(480,r.sessionFile);std::copy(r.journalDigest.begin(),r.journalDigest.end(),bytes.begin()+492);id(524,r.journalFile);id(536,r.intentFile);
    std::copy(journal.begin(),journal.end(),bytes.begin()+brokerCleanJournalOffset);
    const auto digest=checksum(bytes.data(),brokerCleanIntentPayload);std::copy(digest.begin(),digest.end(),bytes.begin()+brokerCleanIntentPayload);return bytes;
}
inline BrokerCleanReleaseIntent decodeBrokerCleanReleaseIntent(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    constexpr uint8_t magic[8]={'T','M','C','C','L','S','1',0};
    if(!bytes||size!=brokerCleanIntentBytes||!std::equal(magic,magic+8,bytes)||wire32(bytes+8)!=1||wire32(bytes+12)!=brokerCleanIntentBytes)
        throw JournalError("mcp-clean-release-format");
    if(!checksum)throw JournalError("mcp-clean-release-checksum-unavailable");
    const auto outer=checksum(bytes,brokerCleanIntentPayload);
    if(!std::equal(outer.begin(),outer.end(),bytes+brokerCleanIntentPayload))throw JournalError("mcp-clean-release-checksum");
    if(wire32(bytes+16)!=brokerCleanWitnessPolicy)throw JournalError("mcp-clean-release-policy");
    for(size_t i=20;i<32;++i)if(bytes[i])throw JournalError("mcp-clean-release-reserved");
    for(size_t i=548;i<brokerCleanJournalOffset;++i)if(bytes[i])throw JournalError("mcp-clean-release-reserved");
    JournalBytes session={};std::copy_n(bytes+32,brokerCleanSessionPrefix,session.data());
    const auto inner=checksum(session.data(),brokerJournalPayloadBytes);std::copy(inner.begin(),inner.end(),session.begin()+brokerJournalPayloadBytes);
    auto id=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    BrokerCleanReleaseIntent r;r.session=decodeBrokerSession(session.data(),session.size(),checksum);
    r.journal=decodeBrokerJournal(bytes+brokerCleanJournalOffset,brokerJournalBytes,checksum);
    std::copy_n(bytes+448,32,r.sessionDigest.data());std::copy_n(bytes+492,32,r.journalDigest.data());
    r.sessionFile=id(480);r.journalFile=id(524);r.intentFile=id(536);validateBrokerCleanReleaseIntent(r);
    if(checksum(session.data(),session.size())!=r.sessionDigest)throw JournalError("mcp-clean-release-session-digest");
    if(checksum(bytes+brokerCleanJournalOffset,brokerJournalBytes)!=r.journalDigest)throw JournalError("mcp-clean-release-journal-digest");
    return r;
}
inline void validateBrokerCleanReleaseCompletion(const BrokerCleanReleaseCompletion& r){
    validateBrokerReleaseCompletion(r.owner);
    if(!releaseNonzero(r.journalDigest))throw JournalError("mcp-clean-release-digest");
    const JournalFileIdentity ids[]={r.owner.control,r.owner.lease,r.owner.intentFile,r.journalFile};
    for(size_t i=0;i<4;++i){
        if(!sessionIdentityPresent(ids[i])||ids[i].volume!=r.owner.control.volume)throw JournalError("mcp-clean-release-identity");
        for(size_t j=0;j<i;++j)if(journalIdentityEqual(ids[i],ids[j]))throw JournalError("mcp-clean-release-identity");
    }
}
inline JournalBytes encodeBrokerCleanReleaseCompletion(const BrokerCleanReleaseCompletion& r,const JournalChecksum& checksum){
    validateBrokerCleanReleaseCompletion(r);if(!checksum)throw JournalError("mcp-clean-release-checksum-unavailable");
    JournalBytes bytes={};constexpr uint8_t magic[8]={'T','M','C','C','L','D','1',0};
    std::copy_n(magic,8,bytes.data());wirePut32(bytes.data()+8,1);wirePut32(bytes.data()+12,brokerJournalBytes);
    std::copy(r.owner.intentDigest.begin(),r.owner.intentDigest.end(),bytes.begin()+16);
    auto id=[&](size_t at,const JournalFileIdentity& value){wirePut32(bytes.data()+at,value.volume);wirePut32(bytes.data()+at+4,value.indexHigh);wirePut32(bytes.data()+at+8,value.indexLow);};
    id(48,r.owner.intentFile);id(60,r.owner.control);id(72,r.owner.lease);wirePut32(bytes.data()+84,r.owner.main.pid);journalPut64(bytes.data()+88,r.owner.main.creationTime);
    std::copy(r.owner.generation.begin(),r.owner.generation.end(),bytes.begin()+96);std::copy(r.owner.sessionDigest.begin(),r.owner.sessionDigest.end(),bytes.begin()+112);
    std::copy(r.journalDigest.begin(),r.journalDigest.end(),bytes.begin()+144);id(176,r.journalFile);wirePut32(bytes.data()+188,brokerCleanWitnessPolicy);
    const auto digest=checksum(bytes.data(),brokerJournalPayloadBytes);std::copy(digest.begin(),digest.end(),bytes.begin()+brokerJournalPayloadBytes);return bytes;
}
inline BrokerCleanReleaseCompletion decodeBrokerCleanReleaseCompletion(const uint8_t* bytes,size_t size,const JournalChecksum& checksum){
    requireReleaseFormat(bytes,size,{'T','M','C','C','L','D','1',0},checksum);
    if(wire32(bytes+188)!=brokerCleanWitnessPolicy)throw JournalError("mcp-clean-release-policy");
    for(size_t i=192;i<brokerJournalPayloadBytes;++i)if(bytes[i])throw JournalError("mcp-clean-release-reserved");
    auto id=[&](size_t at){return JournalFileIdentity{wire32(bytes+at),wire32(bytes+at+4),wire32(bytes+at+8)};};
    BrokerCleanReleaseCompletion r;std::copy_n(bytes+16,32,r.owner.intentDigest.data());r.owner.intentFile=id(48);r.owner.control=id(60);r.owner.lease=id(72);
    r.owner.main={wire32(bytes+84),journalRead64(bytes+88)};std::copy_n(bytes+96,16,r.owner.generation.data());std::copy_n(bytes+112,32,r.owner.sessionDigest.data());
    std::copy_n(bytes+144,32,r.journalDigest.data());r.journalFile=id(176);validateBrokerCleanReleaseCompletion(r);return r;
}
inline size_t brokerCleanReleasePrefix(const std::array<bool,2>& present){
    size_t first=0;while(first<present.size()&&!present[first])++first;
    for(size_t i=first;i<present.size();++i)if(!present[i])throw JournalError("mcp-clean-release-nonprefix");
    return first;
}
}
