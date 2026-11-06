#include "../../../apps/mcp/native/broker-journal-store.h"
#include <iostream>
#include <vector>

namespace {
using namespace mcp_runtime;
size_t cases=0;
void check(bool value,const char* reason){if(!value)throw std::runtime_error(reason);}
template<class Action> void rejected(Action action){try{action();}catch(const JournalError&){return;}throw std::runtime_error("accepted-invalid-record");}
template<class Action> void scenario(const std::string& name,Action action){try{action();++cases;}catch(const std::exception& e){throw std::runtime_error(name+": "+e.what());}}
// Deliberately a test checksum, not SHA-256 or an ownership proof. Production
// passes its existing BCrypt SHA-256 function to this exact same codec/store.
std::array<uint8_t,32> testChecksum(const uint8_t* bytes,size_t size){
    check(bytes&&size==992,"checksum-range");uint64_t state=UINT64_C(14695981039346656037);
    for(size_t i=0;i<size;++i){state^=bytes[i];state*=UINT64_C(1099511628211);}
    std::array<uint8_t,32> result={};for(size_t i=0;i<result.size();++i){state^=state>>12;state^=state<<25;state^=state>>27;result[i]=uint8_t(state>>24);}return result;
}
void seal(JournalBytes& bytes){const auto digest=testChecksum(bytes.data(),992);std::copy(digest.begin(),digest.end(),bytes.begin()+992);}
BrokerJournalRecord valid(BrokerPhase phase=BrokerPhase::Prepared){
    BrokerJournalRecord r;r.phase=phase;r.main={101,UINT64_C(0x0200000000000001)};r.broker={202,UINT64_C(0x0200000000000002)};
    r.generation.fill(0x37);r.stage={7,8,9};r.reservation={7,10,11};r.packageDigest=std::string(64,'a');r.ownerSid="S-1-5-21-100-200-300-1000";
    if(static_cast<uint32_t>(phase)>=2)r.profileSid="S-1-15-2-100-200-300-400-500-600-700";
    if(static_cast<uint32_t>(phase)>=4)r.worker={303,UINT64_C(0x0200000000000003)};
    return r;
}
void codecCases(){
    for(uint32_t phase=0;phase<8;++phase)scenario("phase-roundtrip-"+std::to_string(phase),[&]{
        const auto record=valid(static_cast<BrokerPhase>(phase));const auto bytes=encodeBrokerJournal(record,testChecksum);
        const auto decoded=decodeBrokerJournal(bytes.data(),bytes.size(),testChecksum);check(encodeBrokerJournal(decoded,testChecksum)==bytes,"roundtrip-bytes");
        check(decoded.broker.pid==202&&decoded.broker.creationTime==record.broker.creationTime,"broker-identity-lost");
        check(journalIdentityEqual(decoded.reservation,record.reservation),"reservation-identity-lost");
    });
    scenario("fixed-v2-layout",[]{
        const auto r=valid(BrokerPhase::Running);const auto b=encodeBrokerJournal(r,testChecksum);
        check(b[6]=='2'&&b[7]==0&&wire32(b.data()+8)==2&&wire32(b.data()+12)==1024,"header-layout");
        check(wire32(b.data()+20)==r.broker.pid&&journalRead64(b.data()+504)==r.broker.creationTime,"broker-layout");
        check(wire32(b.data()+24)==r.main.pid&&journalRead64(b.data()+32)==r.main.creationTime,"main-layout");
        check(wire32(b.data()+28)==r.worker.pid&&journalRead64(b.data()+40)==r.worker.creationTime,"worker-layout");
        check(wire32(b.data()+64)==7&&wire32(b.data()+68)==8&&wire32(b.data()+72)==9,"stage-layout");
        check(wire32(b.data()+512)==7&&wire32(b.data()+516)==10&&wire32(b.data()+520)==11,"reservation-layout");
    });
    for(const auto phase:{BrokerPhase::Closing,BrokerPhase::Clean})scenario("early-close-"+std::to_string(static_cast<uint32_t>(phase)),[&]{
        auto r=valid(phase);r.profileSid.clear();r.worker={};const auto b=encodeBrokerJournal(r,testChecksum);decodeBrokerJournal(b.data(),b.size(),testChecksum);
        r.profileSid="S-1-15-2-1";const auto noWorker=encodeBrokerJournal(r,testChecksum);decodeBrokerJournal(noWorker.data(),noWorker.size(),testChecksum);
    });
    scenario("sid-capacities-and-canonical-values",[]{
        auto r=valid(BrokerPhase::Clean);r.ownerSid="S-1-281474976710655";
        for(unsigned i=0;i<15;++i)r.ownerSid+="-4294967295";
        check(r.ownerSid.size()==184,"owner-sid-fixture");r.profileSid="S-1-15";
        for(unsigned i=0;i<13;++i){r.profileSid+="-4294967295";}
        r.profileSid+="-11111111-1";
        check(r.profileSid.size()==160,"profile-sid-fixture");const auto b=encodeBrokerJournal(r,testChecksum);
        check(decodeBrokerJournal(b.data(),b.size(),testChecksum).profileSid==r.profileSid,"maximum-sid-not-preserved");
        r.profileSid+='1';rejected([&]{encodeBrokerJournal(r,testChecksum);});
    });
    for(const auto& sid:std::vector<std::string>{"", "S-2-5-1", "S-1-5-01", "S-1-5-4294967296", "S-1-281474976710656-1", "S-1-5-1-", "S-1-5-1\n", std::string(193,'x')})
        scenario("invalid-owner-sid-"+std::to_string(sid.size()),[&]{auto r=valid();r.ownerSid=sid;rejected([&]{encodeBrokerJournal(r,testChecksum);});});
    for(unsigned mutation=0;mutation<8;++mutation)scenario("identity-mutation-"+std::to_string(mutation),[&]{
        auto r=valid();switch(mutation){case 0:r.main.pid=0;break;case 1:r.main.creationTime=0;break;case 2:r.broker.pid=0;break;case 3:r.broker.creationTime=0;break;
        case 4:r.stage.indexHigh=r.stage.indexLow=0;break;case 5:r.reservation.indexHigh=r.reservation.indexLow=0;break;case 6:r.reservation=r.stage;break;case 7:r.reservation.volume=9;break;}
        rejected([&]{encodeBrokerJournal(r,testChecksum);});
    });
    for(uint32_t phase=0;phase<8;++phase)scenario("invalid-phase-fields-"+std::to_string(phase),[&]{
        auto r=valid(static_cast<BrokerPhase>(phase));
        if(phase<=1)r.profileSid="S-1-15-2-1";else if(phase<=3)r.worker={303,99};else if(phase<=5)r.worker={};else r.profileSid.clear();
        rejected([&]{encodeBrokerJournal(r,testChecksum);});
    });
    scenario("half-worker-identity",[]{auto r=valid(BrokerPhase::Running);r.worker.creationTime=0;rejected([&]{encodeBrokerJournal(r,testChecksum);});});
    scenario("unknown-phase",[]{auto r=valid();r.phase=static_cast<BrokerPhase>(8);rejected([&]{encodeBrokerJournal(r,testChecksum);});});
    scenario("package-canonical-digest",[]{for(const std::string& text:{std::string(63,'a'),std::string(64,'A'),std::string(64,'g')}){auto r=valid();r.packageDigest=text;rejected([&]{encodeBrokerJournal(r,testChecksum);});}});
    scenario("reserved-bytes-all-rejected",[]{
        const auto raw=encodeBrokerJournal(valid(),testChecksum);
        for(size_t at=0;at<992;++at)if((at>=76&&at<80)||at>=524){auto b=raw;b[at]=1;seal(b);rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});}
    });
    scenario("sid-padding-all-rejected",[]{
        const auto r=valid(BrokerPhase::Running);const auto raw=encodeBrokerJournal(r,testChecksum);
        for(const auto& range:{std::pair<size_t,size_t>{148+r.ownerSid.size(),340},std::pair<size_t,size_t>{344+r.profileSid.size(),504}})
            for(size_t at=range.first;at<range.second;++at){auto b=raw;b[at]=1;seal(b);rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});}
    });
    scenario("sid-declared-length-overflow",[]{auto b=encodeBrokerJournal(valid(),testChecksum);wirePut32(b.data()+144,193);seal(b);rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});});
    scenario("truncation-extra-and-null",[]{const auto b=encodeBrokerJournal(valid(),testChecksum);for(const size_t size:{0,1,8,16,991,1023,1025,2048})rejected([&]{decodeBrokerJournal(b.data(),size,testChecksum);});rejected([&]{decodeBrokerJournal(nullptr,1024,testChecksum);});});
    scenario("v1-and-header-mutations",[]{const auto raw=encodeBrokerJournal(valid(),testChecksum);for(unsigned n=0;n<4;++n){auto b=raw;if(n==0){b[6]='1';wirePut32(b.data()+8,1);}if(n==1)b[7]=1;if(n==2)wirePut32(b.data()+8,3);if(n==3)wirePut32(b.data()+12,1023);seal(b);rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});}});
    scenario("checksum-required-and-compared",[]{auto b=encodeBrokerJournal(valid(),testChecksum);b[1000]^=1;rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});b=encodeBrokerJournal(valid(),testChecksum);b[24]^=1;rejected([&]{decodeBrokerJournal(b.data(),b.size(),testChecksum);});rejected([&]{encodeBrokerJournal(valid(),{});});rejected([&]{decodeBrokerJournal(b.data(),b.size(),{});});});
}
struct MemoryStorage final:BrokerJournalStorage {
    JournalBytes disk={};std::vector<std::string> calls;std::string failure;unsigned verifications=0;
    void verify()override{calls.push_back("verify");++verifications;if(failure=="verify-before"||(failure=="verify-after"&&verifications==2))throw std::runtime_error("injected-verify");}
    void write(const JournalBytes& bytes)override{calls.push_back("write");disk=bytes;if(failure=="write"){disk[50]^=1;throw std::runtime_error("injected-partial-write");}}
    void flush()override{calls.push_back("flush");if(failure=="flush")throw std::runtime_error("injected-flush");}
    JournalBytes read()override{calls.push_back("read");if(failure=="read")throw std::runtime_error("injected-read");auto copy=disk;if(failure=="readback")copy[30]^=1;return copy;}
};
void storeCases(){
    scenario("durable-order-and-current",[]{MemoryStorage storage;BrokerJournalCommitter writer(storage,testChecksum);rejected([&]{writer.current();});writer.commit(valid());check(storage.calls==std::vector<std::string>{"verify","write","flush","read","verify"},"wrong-commit-order");check(writer.healthy()&&writer.current().phase==BrokerPhase::Prepared,"commit-not-published");});
    for(const std::string failure:{"verify-before","write","flush","read","readback","verify-after"})scenario("poisoned-writer-"+failure,[&]{
        MemoryStorage storage;storage.failure=failure;BrokerJournalCommitter writer(storage,testChecksum);bool failed=false;
        try{writer.commit(valid());}catch(const std::exception&){failed=true;}check(failed&&!writer.healthy(),"failure-did-not-poison");
        const auto before=storage.calls;rejected([&]{writer.commit(valid());});rejected([&]{writer.current();});check(storage.calls==before,"poisoned-writer-performed-io");
        if(failure=="write")check(std::find(storage.calls.begin(),storage.calls.end(),"flush")==storage.calls.end(),"flush-after-partial-write");
    });
    scenario("invalid-encode-poisons-before-io",[]{MemoryStorage storage;BrokerJournalCommitter writer(storage,testChecksum);auto r=valid();r.broker.pid=0;rejected([&]{writer.commit(r);});check(!writer.healthy()&&storage.calls.empty(),"invalid-record-reached-storage");});
    scenario("checksum-failure-poisons-before-io",[]{MemoryStorage storage;BrokerJournalCommitter writer(storage,[](const uint8_t*,size_t)->std::array<uint8_t,32>{throw JournalError("injected-hash");});rejected([&]{writer.commit(valid());});check(!writer.healthy()&&storage.calls.empty(),"checksum-failure-reached-storage");});
    scenario("failed-next-phase-hides-old-success",[]{MemoryStorage storage;BrokerJournalCommitter writer(storage,testChecksum);writer.commit(valid());storage.failure="flush";bool failed=false;try{writer.commit(valid(BrokerPhase::ProfileCreating));}catch(const std::exception&){failed=true;}check(failed&&!writer.healthy(),"second-commit-not-poisoned");rejected([&]{writer.current();});});
}
}
int main(){try{codecCases();storeCases();std::cout<<"{\"passed\":true,\"cases\":"<<cases<<",\"suite\":\"native-mcp-journal-v2-portable\"}\n";return 0;}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
