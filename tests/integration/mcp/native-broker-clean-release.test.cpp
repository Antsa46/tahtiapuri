#include "../../../apps/mcp/native/broker-clean-release-codec.h"
#include <iostream>

namespace {
using namespace mcp_runtime;
size_t cases=0;
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
template<class Action> void rejected(Action action,const char* expected=nullptr){
    try{action();}catch(const JournalError& e){if(expected)check(std::string(e.what())==expected,"wrong-rejection-stage");return;}
    throw std::runtime_error("accepted-invalid-clean-release");
}
template<class Action> void scenario(const std::string& name,Action action){
    try{action();++cases;}catch(const std::exception& e){throw std::runtime_error(name+": "+e.what());}
}
// A named deterministic test replacement, not cryptographic or Windows proof.
std::array<uint8_t,32> checksum(const uint8_t* bytes,size_t size){
    check(bytes&&(size==992||size==1024||size==2016||size==2048),"checksum-range");
    uint64_t state=UINT64_C(14695981039346656037)^uint64_t(size);
    for(size_t i=0;i<size;++i){state^=bytes[i];state*=UINT64_C(1099511628211);}
    std::array<uint8_t,32> out={};for(auto& b:out){state^=state>>12;state^=state<<25;state^=state>>27;b=uint8_t(state>>24);}return out;
}
template<size_t Size> void reseal(std::array<uint8_t,Size>& bytes){
    const auto digest=checksum(bytes.data(),Size-32);std::copy(digest.begin(),digest.end(),bytes.end()-32);
}
void sourceDigests(BrokerCleanReleaseIntent& r){
    const auto session=encodeBrokerSession(r.session,checksum),journal=encodeBrokerJournal(r.journal,checksum);
    r.sessionDigest=checksum(session.data(),session.size());r.journalDigest=checksum(journal.data(),journal.size());
}
BrokerCleanReleaseIntent valid(){
    BrokerCleanReleaseIntent r;r.session.phase=SessionPhase::BrokerAdmitted;
    r.session.main={101,UINT64_C(0x200000000000001)};r.session.broker={202,UINT64_C(0x200000000000002)};
    r.session.generation.fill(0x37);r.session.descriptorDigest.fill(0x5a);r.session.packageDigest=std::string(64,'a');
    r.session.ownerSid="S-1-5-21-100-200-300-1000";r.session.control={7,0,1};r.session.lease={7,0,2};
    r.session.reservation={7,0,3};r.session.stage={7,0,4};r.sessionFile={7,0,5};r.journalFile={7,0,6};r.intentFile={7,0,7};
    r.journal.phase=BrokerPhase::Clean;r.journal.main=r.session.main;r.journal.broker=r.session.broker;
    r.journal.worker={303,UINT64_C(0x200000000000003)};r.journal.generation=r.session.generation;
    r.journal.stage=r.session.stage;r.journal.reservation=r.session.reservation;
    r.journal.packageDigest=r.session.packageDigest;r.journal.ownerSid=r.session.ownerSid;
    // Synthetic SID shape only. Native owner must still derive and match the
    // actual generation-specific profile SID before any OS cleanup operation.
    r.journal.profileSid="S-1-15-2-101-102-103-104-105-106-107";sourceDigests(r);return r;
}
BrokerCleanReleaseCompletion complete(){
    const auto intent=valid();const auto bytes=encodeBrokerCleanReleaseIntent(intent,checksum);
    BrokerCleanReleaseCompletion r;r.owner.intentDigest=checksum(bytes.data(),bytes.size());r.owner.sessionDigest=intent.sessionDigest;
    r.owner.intentFile=intent.intentFile;r.owner.control=intent.session.control;r.owner.lease=intent.session.lease;
    r.owner.main=intent.session.main;r.owner.generation=intent.session.generation;r.journalFile=intent.journalFile;r.journalDigest=intent.journalDigest;return r;
}
void run(){
    scenario("source-validates-before-intent-file-exists",[]{
        auto r=valid();r.intentFile={};validateBrokerCleanReleaseSource(r);
        rejected([&]{validateBrokerCleanReleaseIntent(r);},"mcp-clean-release-identity");
        r.journal.worker={};rejected([&]{validateBrokerCleanReleaseSource(r);},"mcp-clean-release-context");
    });
    scenario("full-canonical-source-records-survive-roundtrip",[]{
        const auto r=valid();const auto bytes=encodeBrokerCleanReleaseIntent(r,checksum);
        const auto decoded=decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);
        check(encodeBrokerCleanReleaseIntent(decoded,checksum)==bytes,"intent-roundtrip");
        const auto session=encodeBrokerSession(r.session,checksum),journal=encodeBrokerJournal(r.journal,checksum);
        check(encodeBrokerSession(decoded.session,checksum)==session,"full-session-canonical");
        check(std::equal(journal.begin(),journal.end(),bytes.begin()+992),"entire-journal-snapshot");
        check(bytes.size()==2048&&wire32(bytes.data()+12)==2048&&wire32(bytes.data()+16)==1,"intent-header");
        check(decoded.journal.worker.creationTime==UINT64_C(0x200000000000003),"worker-filetime-bits");
        check(decoded.sessionFile.indexLow==5&&decoded.journalFile.indexLow==6&&decoded.intentFile.indexLow==7,"physical-identities");
    });
    scenario("completion-retains-intent-and-journal-context",[]{
        const auto r=complete();const auto bytes=encodeBrokerCleanReleaseCompletion(r,checksum);
        const auto decoded=decodeBrokerCleanReleaseCompletion(bytes.data(),bytes.size(),checksum);
        check(encodeBrokerCleanReleaseCompletion(decoded,checksum)==bytes,"completion-roundtrip");
        check(bytes[3]=='C'&&bytes[5]=='D'&&wire32(bytes.data()+188)==1,"completion-policy");
        check(decoded.owner.main.creationTime==UINT64_C(0x200000000000001)&&decoded.journalFile.indexLow==6,"completion-context");
    });
    scenario("intent-rejects-length-header-and-null-input",[]{
        const auto original=encodeBrokerCleanReleaseIntent(valid(),checksum);
        for(size_t size:{size_t(0),size_t(1024),size_t(2047),size_t(2049)})rejected([&]{decodeBrokerCleanReleaseIntent(original.data(),size,checksum);},"mcp-clean-release-format");
        rejected([&]{decodeBrokerCleanReleaseIntent(nullptr,2048,checksum);},"mcp-clean-release-format");
        for(size_t at:{size_t(0),size_t(8),size_t(12)}){auto bytes=original;bytes[at]^=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-format");}
    });
    scenario("intent-validates-outer-checksum",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[2047]^=1;rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-checksum");});
    scenario("intent-rejects-unknown-policy",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);wirePut32(bytes.data()+16,2);reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-policy");});
    scenario("intent-keeps-reserved-header-zero",[]{
        for(size_t at:{size_t(20),size_t(31),size_t(548),size_t(991)}){auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[at]=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-reserved");}
    });
    scenario("source-session-hash-is-not-only-an-outer-checksum",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[448]^=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-session-digest");});
    scenario("source-journal-hash-is-retained-independently",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[492]^=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-journal-digest");});
    scenario("inner-journal-checksum-remains-mandatory",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[992+48]^=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-journal-checksum");});
    scenario("inner-journal-v1-is-not-normalized",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[992+6]='1';reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-journal-format");});
    scenario("reconstructed-session-still-rejects-reserved-bits",[]{auto bytes=encodeBrokerCleanReleaseIntent(valid(),checksum);bytes[32+100]=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),checksum);},"mcp-session-reserved");});
    scenario("source-digest-must-match-at-encode",[]{
        auto r=valid();r.sessionDigest[0]^=1;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-session-digest");
        r=valid();r.journalDigest[0]^=1;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-journal-digest");
    });
    scenario("ready-is-not-admitted",[]{auto r=valid();r.session.phase=SessionPhase::Ready;r.session.broker={};rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");});
    scenario("running-is-not-clean",[]{auto r=valid();r.journal.phase=BrokerPhase::Running;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");});
    scenario("clean-needs-full-worker-and-profile-pair",[]{
        auto r=valid();r.journal.worker={};r.journal.profileSid.clear();rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");
        r=valid();r.journal.worker={};rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");
    });
    scenario("worker-cannot-alias-main-or-broker",[]{
        for(uint32_t pid:{101U,202U}){auto r=valid();r.journal.worker.pid=pid;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");}
    });
    scenario("journal-process-identities-must-match-session",[]{
        auto r=valid();++r.journal.main.creationTime;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");
        r=valid();++r.journal.broker.creationTime;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");
    });
    scenario("journal-context-is-bound-before-hash-checks",[]{
        const std::vector<std::function<void(BrokerCleanReleaseIntent&)>> changes={
            [](auto& r){r.journal.generation[0]^=1;},[](auto& r){r.journal.ownerSid="S-1-5-21-100-200-300-1001";},
            [](auto& r){r.journal.packageDigest=std::string(64,'b');},[](auto& r){r.journal.stage.indexLow=8;},[](auto& r){r.journal.reservation.indexLow=9;}};
        for(const auto& change:changes){auto r=valid();change(r);rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-context");}
    });
    scenario("record-file-identities-are-present-distinct-and-local",[]{
        for(size_t i=0;i<3;++i){
            auto r=valid();auto& id=i==0?r.sessionFile:i==1?r.journalFile:r.intentFile;id={};rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-identity");
            r=valid();auto& foreign=i==0?r.sessionFile:i==1?r.journalFile:r.intentFile;foreign.volume=8;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-identity");
            r=valid();auto& alias=i==0?r.sessionFile:i==1?r.journalFile:r.intentFile;alias=r.session.lease;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-identity");
        }
        auto r=valid();r.journalFile=r.intentFile;rejected([&]{encodeBrokerCleanReleaseIntent(r,checksum);},"mcp-clean-release-identity");
    });
    scenario("completion-format-checksum-policy-and-padding",[]{
        const auto original=encodeBrokerCleanReleaseCompletion(complete(),checksum);
        for(size_t size:{size_t(0),size_t(1023),size_t(1025)})rejected([&]{decodeBrokerCleanReleaseCompletion(original.data(),size,checksum);},"mcp-release-format");
        auto bytes=original;bytes[1023]^=1;rejected([&]{decodeBrokerCleanReleaseCompletion(bytes.data(),bytes.size(),checksum);},"mcp-release-checksum");
        bytes=original;wirePut32(bytes.data()+188,2);reseal(bytes);rejected([&]{decodeBrokerCleanReleaseCompletion(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-policy");
        for(size_t at:{size_t(192),size_t(991)}){bytes=original;bytes[at]=1;reseal(bytes);rejected([&]{decodeBrokerCleanReleaseCompletion(bytes.data(),bytes.size(),checksum);},"mcp-clean-release-reserved");}
    });
    scenario("completion-does-not-alias-own-records",[]{
        auto r=complete();r.journalFile=r.owner.lease;rejected([&]{encodeBrokerCleanReleaseCompletion(r,checksum);},"mcp-clean-release-identity");
        r=complete();r.journalDigest.fill(0);rejected([&]{encodeBrokerCleanReleaseCompletion(r,checksum);},"mcp-clean-release-digest");
        r=complete();r.owner.main.creationTime=0;rejected([&]{encodeBrokerCleanReleaseCompletion(r,checksum);},"mcp-release-completion-fields");
    });
    scenario("pristine-and-clean-domains-remain-distinct",[]{
        const auto completion=complete();const auto pristine=encodeBrokerReleaseCompletion(completion.owner,checksum);
        rejected([&]{decodeBrokerCleanReleaseCompletion(pristine.data(),pristine.size(),checksum);},"mcp-release-format");
        const auto clean=encodeBrokerCleanReleaseIntent(valid(),checksum);
        rejected([&]{decodeBrokerReleaseIntent(clean.data(),clean.size(),checksum);},"mcp-release-format");
        rejected([&]{decodeBrokerCleanReleaseIntent(pristine.data(),pristine.size(),checksum);},"mcp-clean-release-format");
    });
    scenario("missing-checksum-provider-refuses",[]{
        const auto r=valid();rejected([&]{encodeBrokerCleanReleaseIntent(r,{});},"mcp-clean-release-checksum-unavailable");
        const auto bytes=encodeBrokerCleanReleaseIntent(r,checksum);rejected([&]{decodeBrokerCleanReleaseIntent(bytes.data(),bytes.size(),{});},"mcp-clean-release-checksum-unavailable");
    });
    for(size_t frontier=0;frontier<=2;++frontier)scenario("fixed-removed-prefix-"+std::to_string(frontier),[&]{check(brokerCleanReleasePrefix({frontier==0,frontier<=1})==frontier,"prefix");});
    scenario("reservation-hole-is-not-a-removal-prefix",[]{rejected([]{brokerCleanReleasePrefix({true,false});},"mcp-clean-release-nonprefix");});
}
}
int main(){
    try{run();std::cout<<"{\"passed\":true,\"suite\":\"native-mcp-clean-release-portable\",\"cases\":"<<cases<<"}\n";return 0;}
    catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
