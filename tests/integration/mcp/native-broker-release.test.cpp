#include "../../../apps/mcp/native/broker-release-codec.h"
#include <iostream>

namespace {
using namespace mcp_runtime;
size_t cases=0;
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
template<class Action> void rejected(Action action){try{action();}catch(const JournalError&){return;}throw std::runtime_error("accepted-invalid-release");}
template<class Action> void scenario(const std::string& name,Action action){try{action();++cases;}catch(const std::exception& e){throw std::runtime_error(name+": "+e.what());}}
// Explicitly a test replacement; real persistence uses Windows BCrypt SHA-256.
std::array<uint8_t,32> checksum(const uint8_t* bytes,size_t size){
    check(bytes&&size==992,"checksum-range");uint64_t state=UINT64_C(14695981039346656037);
    for(size_t i=0;i<size;++i){state^=bytes[i];state*=UINT64_C(1099511628211);}
    std::array<uint8_t,32> out={};for(auto& b:out){state^=state>>12;state^=state<<25;state^=state>>27;b=uint8_t(state>>24);}return out;
}
void reseal(JournalBytes& bytes){const auto digest=checksum(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);}
BrokerReleaseIntent valid(){
    BrokerReleaseIntent r;r.session.phase=SessionPhase::Ready;r.session.main={101,UINT64_C(0x200000000000001)};
    r.session.generation.fill(0x37);r.session.descriptorDigest.fill(0x5a);r.session.packageDigest=std::string(64,'a');
    r.session.ownerSid="S-1-5-21-100-200-300-1000";r.session.control={7,0,1};r.session.lease={7,0,3};
    r.sessionFile={7,0,5};r.intentFile={7,0,6};r.sessionDigest.fill(0x7e);
    for(size_t i=0;i<r.targets.size();++i){
        r.targets[i].identity={7,0,static_cast<uint32_t>(10+i)};
        if(i<brokerReleaseFiles){r.targets[i].bytes=100+i;r.targets[i].digest.fill(static_cast<uint8_t>(0x50+i));}
    }
    r.session.stage=r.targets[11].identity;r.session.reservation=r.targets[12].identity;return r;
}
BrokerReleaseCompletion complete(){
    const auto intent=valid();BrokerReleaseCompletion r;r.intentDigest.fill(0x15);r.sessionDigest=intent.sessionDigest;
    r.intentFile=intent.intentFile;r.control=intent.session.control;r.lease=intent.session.lease;r.main=intent.session.main;
    r.generation=intent.session.generation;return r;
}
void run(){
    scenario("intent-layout-and-roundtrip",[]{
        const auto r=valid(),decoded=decodeBrokerReleaseIntent(encodeBrokerReleaseIntent(r,checksum).data(),1024,checksum);
        const auto bytes=encodeBrokerReleaseIntent(r,checksum);check(encodeBrokerReleaseIntent(decoded,checksum)==bytes,"roundtrip");
        check(bytes[6]=='1'&&bytes[7]==0&&wire32(bytes.data()+8)==1&&wire32(bytes.data()+12)==1024,"header");
        check(wire32(bytes.data()+60)==r.session.main.pid&&journalRead64(bytes.data()+64)==r.session.main.creationTime,"main");
        check(wire32(bytes.data()+48)==7&&wire32(bytes.data()+56)==5&&wire32(bytes.data()+916)==6,"record-identities");
        check(wire32(bytes.data()+232)==r.session.ownerSid.size()&&journalRead64(bytes.data()+588)==100,"text-and-size");
        check(decoded.targets[12].identity.indexLow==22&&decoded.targets[7].bytes==107,"target-order");
    });
    scenario("completion-layout-and-roundtrip",[]{
        const auto r=complete();const auto bytes=encodeBrokerReleaseCompletion(r,checksum);
        check(bytes[5]=='D'&&wire32(bytes.data()+84)==101&&journalRead64(bytes.data()+88)==r.main.creationTime,"completion-fields");
        check(encodeBrokerReleaseCompletion(decodeBrokerReleaseCompletion(bytes.data(),bytes.size(),checksum),checksum)==bytes,"completion-roundtrip");
    });
    scenario("intent-format-and-checksum",[]{
        const auto original=encodeBrokerReleaseIntent(valid(),checksum);
        for(size_t size:{size_t(0),size_t(1023),size_t(1025)})rejected([&]{decodeBrokerReleaseIntent(original.data(),size,checksum);});
        rejected([&]{decodeBrokerReleaseIntent(nullptr,1024,checksum);});
        for(size_t at:{size_t(0),size_t(8),size_t(12),size_t(1000)}){
            auto bytes=original;bytes[at]^=1;if(at!=1000)reseal(bytes);rejected([&]{decodeBrokerReleaseIntent(bytes.data(),bytes.size(),checksum);});
        }
    });
    scenario("intent-reserved-and-owner-padding",[]{
        for(size_t at:{size_t(236+40),size_t(428),size_t(431),size_t(920),size_t(991)}){
            auto bytes=encodeBrokerReleaseIntent(valid(),checksum);bytes[at]=1;reseal(bytes);
            rejected([&]{decodeBrokerReleaseIntent(bytes.data(),bytes.size(),checksum);});
        }
        auto bytes=encodeBrokerReleaseIntent(valid(),checksum);wirePut32(bytes.data()+232,193);reseal(bytes);
        rejected([&]{decodeBrokerReleaseIntent(bytes.data(),bytes.size(),checksum);});
    });
    scenario("pristine-only",[]{
        for(auto phase:{SessionPhase::Preparing,SessionPhase::BrokerAdmitted}){
            auto r=valid();r.session.phase=phase;
            if(phase==SessionPhase::Preparing)r.session.stage={};else r.session.broker={202,2};
            rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        }
    });
    scenario("all-target-identities-are-distinct-and-local",[]{
        for(size_t i=0;i<brokerReleaseTargets;++i){
            auto r=valid();r.targets[i].identity.volume=8;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
            r=valid();r.targets[i].identity=r.intentFile;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
            r=valid();r.targets[i].identity=r.sessionFile;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        }
        auto r=valid();r.intentFile=r.sessionFile;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        r=valid();r.targets[1].identity=r.targets[0].identity;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
    });
    scenario("file-and-directory-metadata",[]{
        for(size_t i=0;i<brokerReleaseTargets;++i){
            auto r=valid();
            if(i<brokerReleaseFiles)r.targets[i].bytes=0;else r.targets[i].bytes=1;
            rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
            r=valid();r.targets[i].digest.fill(i<brokerReleaseFiles?0:1);rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        }
        auto r=valid();r.targets[0].bytes=128ULL*1024*1024+1;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
    });
    scenario("root-bindings-and-digest",[]{
        auto r=valid();r.sessionDigest.fill(0);rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        r=valid();r.targets[11].identity.indexLow=1000;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
        r=valid();r.targets[12].identity.indexLow=1000;rejected([&]{encodeBrokerReleaseIntent(r,checksum);});
    });
    scenario("completion-reserved-and-format",[]{
        const auto original=encodeBrokerReleaseCompletion(complete(),checksum);
        for(size_t at:{size_t(0),size_t(8),size_t(12),size_t(144),size_t(991),size_t(1000)}){
            auto bytes=original;bytes[at]^=1;if(at!=1000)reseal(bytes);rejected([&]{decodeBrokerReleaseCompletion(bytes.data(),bytes.size(),checksum);});
        }
        rejected([&]{decodeBrokerReleaseCompletion(nullptr,1024,checksum);});
    });
    scenario("completion-context-fields",[]{
        for(unsigned mutation=0;mutation<7;++mutation){
            auto r=complete();
            if(mutation==0)r.intentDigest.fill(0);else if(mutation==1)r.sessionDigest.fill(0);else if(mutation==2)r.generation.fill(0);
            else if(mutation==3)r.main.creationTime=0;else if(mutation==4)r.main.pid=0;
            else if(mutation==5)r.intentFile=r.control;else r.lease.volume=8;
            rejected([&]{encodeBrokerReleaseCompletion(r,checksum);});
        }
    });
    scenario("checksum-provider-required",[]{
        const auto intent=encodeBrokerReleaseIntent(valid(),checksum),done=encodeBrokerReleaseCompletion(complete(),checksum);
        rejected([&]{encodeBrokerReleaseIntent(valid(),{});});rejected([&]{encodeBrokerReleaseCompletion(complete(),{});});
        rejected([&]{decodeBrokerReleaseIntent(intent.data(),intent.size(),{});});
        rejected([&]{decodeBrokerReleaseCompletion(done.data(),done.size(),{});});
    });
    for(size_t removed=0;removed<=brokerReleaseTargets;++removed)scenario("valid-prefix-"+std::to_string(removed),[&]{
        std::array<bool,brokerReleaseTargets> present={};std::fill(present.begin()+removed,present.end(),true);
        check(brokerReleasePrefix(present)==removed,"prefix-frontier");
    });
    for(size_t hole=1;hole<brokerReleaseTargets;++hole)scenario("nonprefix-hole-"+std::to_string(hole),[&]{
        std::array<bool,brokerReleaseTargets> present={};present.fill(true);present[hole]=false;
        rejected([&]{brokerReleasePrefix(present);});
    });
}
}
int main(){try{run();std::cout<<"{\"passed\":true,\"cases\":"<<cases<<",\"suite\":\"native-mcp-release-portable\"}\n";return 0;}
catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
