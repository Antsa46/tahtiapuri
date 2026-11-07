#include "../../../apps/mcp/native/broker-session-store.h"
#include <iostream>

namespace {
using namespace mcp_runtime;
size_t cases=0;
void check(bool value,const char* why){if(!value)throw std::runtime_error(why);}
template<class Action> void rejected(Action action){try{action();}catch(const JournalError&){return;}throw std::runtime_error("accepted-invalid-session");}
template<class Action> void scenario(const char* name,Action action){try{action();++cases;}catch(const std::exception& e){throw std::runtime_error(std::string(name)+": "+e.what());}}
// Test-only checksum. Native persistence uses BCrypt SHA-256, never this seam.
std::array<uint8_t,32> testChecksum(const uint8_t* bytes,size_t size){
    check(bytes&&size==992,"checksum-range");uint64_t state=UINT64_C(14695981039346656037);
    for(size_t i=0;i<size;++i){state^=bytes[i];state*=UINT64_C(1099511628211);}
    std::array<uint8_t,32> out={};for(auto& b:out){state^=state>>12;state^=state<<25;state^=state>>27;b=uint8_t(state>>24);}return out;
}
void seal(JournalBytes& b){const auto digest=testChecksum(b.data(),992);std::copy(digest.begin(),digest.end(),b.begin()+992);}
BrokerSessionRecord valid(SessionPhase phase=SessionPhase::Preparing){
    BrokerSessionRecord r;r.phase=phase;r.main={101,UINT64_C(0x200000000000001)};r.generation.fill(0x37);r.descriptorDigest.fill(0x5a);
    r.control={7,0,1};r.reservation={7,0,2};r.lease={7,0,3};
    r.packageDigest=std::string(64,'a');r.ownerSid="S-1-5-21-100-200-300-1000";
    if(phase!=SessionPhase::Preparing)r.stage={7,0,4};
    if(phase==SessionPhase::BrokerAdmitted)r.broker={202,UINT64_C(0x200000000000002)};
    return r;
}
void run(){
    for(const auto phase:{SessionPhase::Preparing,SessionPhase::Ready,SessionPhase::BrokerAdmitted})
        scenario("phase-roundtrip",[&]{const auto r=valid(phase);const auto b=encodeBrokerSession(r,testChecksum);
            check(encodeBrokerSession(decodeBrokerSession(b.data(),b.size(),testChecksum),testChecksum)==b,"roundtrip");});
    scenario("fixed-layout",[]{
        const auto r=valid(SessionPhase::BrokerAdmitted);const auto b=encodeBrokerSession(r,testChecksum);
        check(b[6]=='1'&&b[7]==0&&wire32(b.data()+8)==1&&wire32(b.data()+12)==1024,"header");
        check(wire32(b.data()+16)==2&&wire32(b.data()+20)==101&&journalRead64(b.data()+24)==r.main.creationTime,"owner");
        check(std::equal(r.generation.begin(),r.generation.end(),b.begin()+32),"generation");
        check(std::equal(r.descriptorDigest.begin(),r.descriptorDigest.end(),b.begin()+384),"descriptor-digest");
        check(wire32(b.data()+48)==7&&wire32(b.data()+56)==1&&wire32(b.data()+68)==2&&wire32(b.data()+80)==4&&wire32(b.data()+92)==3,"files");
        check(wire32(b.data()+96)==202&&journalRead64(b.data()+104)==r.broker.creationTime,"broker");
        check(std::string(b.begin()+112,b.begin()+176)==r.packageDigest&&wire32(b.data()+176)==r.ownerSid.size(),"text");
    });
    scenario("zero-volume-is-valid",[]{auto r=valid(SessionPhase::Ready);r.control.volume=r.reservation.volume=r.lease.volume=r.stage.volume=0;const auto b=encodeBrokerSession(r,testChecksum);decodeBrokerSession(b.data(),b.size(),testChecksum);});
    scenario("invalid-main-and-generation",[]{
        for(unsigned i=0;i<4;++i){auto r=valid();if(i==0)r.main.pid=0;else if(i==1)r.main.creationTime=0;else if(i==2)r.generation.fill(0);else r.descriptorDigest.fill(0);rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("closed-file-identities",[]{
        for(unsigned i=0;i<8;++i){auto r=valid();switch(i){
            case 0:r.control={};break;case 1:r.reservation={};break;case 2:r.lease={};break;case 3:r.reservation=r.control;break;
            case 4:r.lease=r.reservation;break;case 5:r.lease=r.control;break;case 6:r.reservation.volume=9;break;case 7:r.lease.volume=9;break;}
            rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("preparing-stage-is-unset",[]{for(unsigned i=0;i<3;++i){auto r=valid();if(i==0)r.stage.volume=7;else if(i==1)r.stage.indexHigh=1;else r.stage.indexLow=1;rejected([&]{encodeBrokerSession(r,testChecksum);});}});
    scenario("ready-stage-is-bound",[]{
        for(unsigned i=0;i<5;++i){auto r=valid(SessionPhase::Ready);if(i==0)r.stage={};else if(i==1)r.stage.volume=9;
            else if(i==2)r.stage=r.control;else if(i==3)r.stage=r.reservation;else r.stage=r.lease;
            rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("pre-admission-has-no-broker",[]{
        for(const auto phase:{SessionPhase::Preparing,SessionPhase::Ready})for(unsigned i=0;i<3;++i){auto r=valid(phase);r.broker={i==1?0u:202u,i==0?0u:99u};rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("admission-requires-distinct-full-broker",[]{
        for(unsigned i=0;i<3;++i){auto r=valid(SessionPhase::BrokerAdmitted);if(i==0)r.broker.pid=0;else if(i==1)r.broker.creationTime=0;else r.broker.pid=r.main.pid;rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("unknown-phase",[]{auto r=valid();r.phase=static_cast<SessionPhase>(3);rejected([&]{encodeBrokerSession(r,testChecksum);});});
    scenario("canonical-owner-and-package",[]{
        for(const std::string sid:{"","S-1-5-01","S-1-5-4294967296","S-1-5-1\n"}){auto r=valid();r.ownerSid=sid;rejected([&]{encodeBrokerSession(r,testChecksum);});}
        for(const std::string& digest:{std::string(63,'a'),std::string(64,'A'),std::string(64,'g')}){auto r=valid();r.packageDigest=digest;rejected([&]{encodeBrokerSession(r,testChecksum);});}
    });
    scenario("reserved-and-padding-bytes",[]{
        const auto r=valid(SessionPhase::BrokerAdmitted);const auto raw=encodeBrokerSession(r,testChecksum);
        for(size_t i=0;i<992;++i)if((i>=100&&i<104)||(i>=372&&i<384)||i>=416||(i>=180+r.ownerSid.size()&&i<372)){
            auto b=raw;b[i]=1;seal(b);rejected([&]{decodeBrokerSession(b.data(),b.size(),testChecksum);});}
    });
    scenario("declared-owner-overflow",[]{auto b=encodeBrokerSession(valid(),testChecksum);wirePut32(b.data()+176,193);seal(b);rejected([&]{decodeBrokerSession(b.data(),b.size(),testChecksum);});});
    scenario("all-truncations-and-extra-input",[]{
        const auto b=encodeBrokerSession(valid(),testChecksum);for(size_t n=0;n<1024;++n)rejected([&]{decodeBrokerSession(b.data(),n,testChecksum);});
        rejected([&]{decodeBrokerSession(b.data(),1025,testChecksum);});rejected([&]{decodeBrokerSession(nullptr,1024,testChecksum);});
    });
    scenario("version-header-and-journal-refusal",[]{
        const auto raw=encodeBrokerSession(valid(),testChecksum);
        for(unsigned i=0;i<4;++i){auto b=raw;if(i==0)b[7]=1;else if(i==1)wirePut32(b.data()+8,2);else if(i==2)wirePut32(b.data()+12,1023);else b[3]='J';
            seal(b);rejected([&]{decodeBrokerSession(b.data(),b.size(),testChecksum);});}
        rejected([&]{decodeBrokerJournal(raw.data(),raw.size(),testChecksum);});
    });
    scenario("checksum-compared-and-required",[]{
        auto b=encodeBrokerSession(valid(),testChecksum);b[1000]^=1;rejected([&]{decodeBrokerSession(b.data(),b.size(),testChecksum);});
        b=encodeBrokerSession(valid(),testChecksum);b[20]^=1;rejected([&]{decodeBrokerSession(b.data(),b.size(),testChecksum);});
        rejected([&]{encodeBrokerSession(valid(),{});});rejected([&]{decodeBrokerSession(b.data(),b.size(),{});});
    });
    scenario("lease-header-is-fixed",[]{const auto b=brokerLeaseHeader();check(b.size()==32&&wire32(b.data()+8)==1&&wire32(b.data()+12)==32,"lease-header");for(size_t i=16;i<32;++i)check(!b[i],"lease-reserved");});
}

struct MemoryStorage final:BrokerJournalStorage {
    JournalBytes disk={};std::vector<std::string> calls;std::string failure;unsigned verifications=0;
    void verify()override{
        calls.push_back("verify");++verifications;
        if(failure=="verify-before"||(failure=="verify-after"&&verifications==2))throw std::runtime_error("injected-verify");
    }
    void write(const JournalBytes& bytes)override{
        calls.push_back("write");disk=bytes;
        if(failure=="write"){disk[40]^=1;throw std::runtime_error("injected-partial-write");}
    }
    void flush()override{calls.push_back("flush");if(failure=="flush")throw std::runtime_error("injected-flush");}
    JournalBytes read()override{
        calls.push_back("read");if(failure=="read")throw std::runtime_error("injected-read");
        auto bytes=disk;if(failure=="readback")bytes[40]^=1;return bytes;
    }
};
template<class Action> void fails(Action action){bool caught=false;try{action();}catch(const std::exception&){caught=true;}check(caught,"missing-failure");}
void noMoreIo(BrokerSessionStore& store,MemoryStorage& io){
    const auto calls=io.calls;
    check(!store.healthy(),"store-not-poisoned");rejected([&]{store.current();});
    rejected([&]{store.load();});rejected([&]{store.commit(valid());});check(io.calls==calls,"io-after-poison");
}
void storeCases(){
    scenario("session-commit-order",[]{
        MemoryStorage io;BrokerSessionStore store(io,testChecksum);rejected([&]{store.current();});
        store.commit(valid());check(store.current().phase==SessionPhase::Preparing,"missing-current");
        check(io.calls==std::vector<std::string>{"verify","write","flush","read","verify"},"commit-order");
    });
    scenario("session-load-order",[]{
        MemoryStorage io;io.disk=encodeBrokerSession(valid(SessionPhase::Ready),testChecksum);BrokerSessionStore store(io,testChecksum);
        check(store.load().phase==SessionPhase::Ready&&store.current().phase==SessionPhase::Ready,"load-value");
        check(io.calls==std::vector<std::string>{"verify","read","verify"},"load-order");
    });
    for(const std::string failure:{"verify-before","write","flush","read","readback","verify-after"}){
        const auto name="commit-poison-"+failure;
        scenario(name.c_str(),[&]{
            MemoryStorage io;io.failure=failure;BrokerSessionStore store(io,testChecksum);
            fails([&]{store.commit(valid());});noMoreIo(store,io);
            if(failure=="write")check(std::find(io.calls.begin(),io.calls.end(),"flush")==io.calls.end(),"flush-after-partial");
        });
    }
    for(const std::string failure:{"verify-before","read","readback","verify-after"}){
        const auto name="load-poison-"+failure;
        scenario(name.c_str(),[&]{
            MemoryStorage io;io.disk=encodeBrokerSession(valid(),testChecksum);io.failure=failure;BrokerSessionStore store(io,testChecksum);
            fails([&]{store.load();});noMoreIo(store,io);
        });
    }
    scenario("decode-failure-poisons-load",[]{
        MemoryStorage io;io.disk=encodeBrokerSession(valid(),testChecksum);wirePut32(io.disk.data()+16,3);seal(io.disk);
        BrokerSessionStore store(io,testChecksum);rejected([&]{store.load();});noMoreIo(store,io);
    });
    scenario("failed-load-hides-previous-current",[]{
        MemoryStorage io;io.disk=encodeBrokerSession(valid(),testChecksum);BrokerSessionStore store(io,testChecksum);store.load();
        io.calls.clear();io.verifications=0;io.disk[1000]^=1;
        rejected([&]{store.load();});noMoreIo(store,io);
    });
    scenario("failed-commit-hides-previous-current",[]{
        MemoryStorage io;BrokerSessionStore store(io,testChecksum);store.commit(valid());
        io.calls.clear();io.verifications=0;io.failure="flush";fails([&]{store.commit(valid(SessionPhase::Ready));});noMoreIo(store,io);
    });
    scenario("invalid-commit-never-reaches-io",[]{
        MemoryStorage io;BrokerSessionStore store(io,testChecksum);auto record=valid();record.main.pid=0;
        rejected([&]{store.commit(record);});check(io.calls.empty(),"invalid-commit-io");noMoreIo(store,io);
    });
    scenario("missing-checksum-poisons-before-io",[]{
        for(bool load:{false,true}){
            MemoryStorage io;BrokerSessionStore store(io,{});
            rejected([&]{if(load)store.load();else store.commit(valid());});
            check(io.calls.empty(),"missing-checksum-io");noMoreIo(store,io);
        }
    });
    scenario("throwing-checksum-poisons",[]{
        for(bool load:{false,true}){
            MemoryStorage io;io.disk=encodeBrokerSession(valid(),testChecksum);
            BrokerSessionStore store(io,[](const uint8_t*,size_t)->std::array<uint8_t,32>{throw JournalError("injected-checksum");});
            rejected([&]{if(load)store.load();else store.commit(valid());});noMoreIo(store,io);
        }
    });
}
}
int main(){try{run();storeCases();std::cout<<"{\"passed\":true,\"cases\":"<<cases<<",\"suite\":\"native-mcp-session-portable\"}\n";return 0;}
catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
