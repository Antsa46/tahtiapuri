// Default unit entry is synthetic only. No filesystem, profile, process, Job,
// token or network adapter is instantiated. Real Windows guards need a separate
// explicitly admitted fresh-root exercise. Hashing/UTF8 checks are read-only.
#include "../../../apps/backend/native/backend-observing-migration.h"
#include <utility>

namespace {
using namespace backend_runtime;
static_assert(MigrationDecision==6&&MigrationSourceFrame==134&&MigrationDestinationFrame==135&&Migrated==136,"The Main/native TBIP kinds must agree.");
void check(bool value,const char* stage){if(!value)throw WinError(stage,ERROR_ASSERTION_FAILURE);}
template<class Action> void rejected(Action action,const char* stage){try{action();}catch(const WinError&){return;}throw WinError(stage,ERROR_ASSERTION_FAILURE);}
const MigrationContext context{"S-1-5-21-100-200-300-1001",std::string(24,'a'),std::string(24,'b')};
std::string document(unsigned revision){const auto state="{\"revision\":"+std::to_string(revision)+",\"places\":[],\"activePlaceId\":null}";return "{\"schemaVersion\":1,\"state\":"+state+",\"sha256\":\""+migrationHash(state)+"\"}\n";}
struct MemoryIo final:ObservingMigrationIo {
    MigrationSource legacy{document(7),std::string(24,'c'),false};bool legacyPresent=true,guard=false,released=false,lateCreation=false,raceAtPublish=false;
    MigrationDestination target;MigrationMarker completed;std::string failAt,corruptAt;
    struct Temp{std::string bytes;bool exists=false,flushed=false;unsigned flushes=0;};std::array<Temp,2> temps;
    std::vector<std::string> events;unsigned reservations=0;
    size_t index(MigrationSlot slot)const{return slot==MigrationSlot::Destination?0:1;}
    std::string name(MigrationSlot slot)const{return slot==MigrationSlot::Destination?"destination":"marker";}
    void hit(const std::string& event){events.push_back(event);if(event==failAt)throw WinError("injected-migration-io",ERROR_WRITE_FAULT);}
    void restart(){guard=false;released=false;failAt.clear();corruptAt.clear();events.clear();for(auto& temp:temps)temp.flushes=0;}
    size_t calls(const std::string& event)const{return static_cast<size_t>(std::count(events.begin(),events.end(),event));}
    MigrationMarker marker() override{hit("marker-load");check(!temps[0].exists&&!temps[1].exists,"fake-pending-temp-block");return completed;}
    MigrationSource acquireSource(bool reserve) override {
        hit("source-acquire");if(!legacyPresent){check(reserve,"fake-source-missing-completed");
            if(lateCreation){legacyPresent=true;legacy.bytes=document(4);throw WinError("fake-create-new-lost-race",ERROR_FILE_EXISTS);}
            ++reservations;legacyPresent=true;legacy.bytes.clear();guard=true;hit("source-create-new");
            legacy.bytes=migrationEmptyEnvelope();hit("source-flush");hit("source-readback");guard=true;auto snapshot=legacy;snapshot.reserved=true;return snapshot;
        }
        guard=true;auto snapshot=legacy;snapshot.reserved=false;return snapshot;
    }
    MigrationDestination destination() override{hit("destination-snapshot");check(guard,"fake-guard-before-snapshot");return target;}
    void verify(const MigrationSource& source,const MigrationDestination& destination) override {
        hit("verify");check(guard&&legacy.identity==source.identity&&legacy.bytes==source.bytes,"fake-source-fingerprint");check(target.present==destination.present&&target.bytes==destination.bytes,"fake-destination-fingerprint");
    }
    void createTemp(MigrationSlot slot) override {
        hit(name(slot)+"-create");check(guard,"fake-guard-through-publication");auto& temp=temps[index(slot)];check(!temp.exists,"fake-create-new-temp");
        check(slot==MigrationSlot::Destination?!target.present:!completed.present,"fake-no-replace-final");temp.exists=true;
    }
    void writeTemp(MigrationSlot slot,const std::string& bytes) override {hit(name(slot)+"-write");auto& temp=temps[index(slot)];check(temp.exists,"fake-write-created-temp");temp.bytes=bytes;}
    void flushTemp(MigrationSlot slot) override {auto& temp=temps[index(slot)];hit(name(slot)+"-flush-"+std::to_string(++temp.flushes));temp.flushed=true;}
    std::string readTemp(MigrationSlot slot) override {const auto event=name(slot)+"-readback";hit(event);auto& temp=temps[index(slot)];check(temp.exists&&temp.flushed,"fake-readback-after-flush");return temp.bytes+(event==corruptAt?"x":"");}
    void publishTemp(MigrationSlot slot) override {
        hit(name(slot)+"-publish");auto& temp=temps[index(slot)];check(temp.exists&&temp.flushed,"fake-publish-durable-temp");if(raceAtPublish&&slot==MigrationSlot::Destination)target={document(8),true};check(slot==MigrationSlot::Destination?!target.present:!completed.present,"fake-no-replace-publication");
        if(slot==MigrationSlot::Destination)target={temp.bytes,true};else completed={temp.bytes,true};temp.exists=false;
    }
    std::string readPublished(MigrationSlot slot) override {const auto event=name(slot)+"-published-readback";hit(event);return (slot==MigrationSlot::Destination?target.bytes:completed.bytes)+(event==corruptAt?"x":"");}
    void releaseDestination() override{hit("release-destination");released=true;check(guard,"fake-source-stays-held");}
};
std::array<BYTE,32> hashRaw(const std::string& bytes){const auto text=migrationHash(bytes);std::array<BYTE,32> result={};auto digit=[](char c){return c<='9'?c-'0':c-'a'+10;};for(size_t i=0;i<32;++i)result[i]=static_cast<BYTE>(digit(text[i*2])*16+digit(text[i*2+1]));return result;}
std::vector<BYTE> decision(const MigrationSource& source,const MigrationDestination& target,BYTE action){
    std::vector<BYTE> bytes(68,0);bytes[0]=1;bytes[1]=action;bytes[2]=target.present?1:0;const auto a=hashRaw(source.bytes),b=target.present?hashRaw(target.bytes):std::array<BYTE,32>{};std::copy(a.begin(),a.end(),bytes.begin()+4);std::copy(b.begin(),b.end(),bytes.begin()+36);return bytes;
}
void frames(ObservingMigration& migration){check(migration.sourceFrame().size()>=5,"source-frame");check(migration.destinationFrame().size()>=4,"destination-frame");}
void noPublication(const MemoryIo& io){check(io.calls("destination-create")==0&&io.calls("marker-create")==0&&!io.released,"no-publication-on-failure");}
void ordinaryCopy(){
    MemoryIo io;io.legacy.bytes=" \n"+io.legacy.bytes+" \n";ObservingMigration migration(context,io);const auto source=migration.sourceFrame(),target=migration.destinationFrame();
    check(source[0]==1&&source[1]==0&&source[2]==0&&source[3]==0&&std::string(source.begin()+4,source.end())==io.legacy.bytes,"source-prefix-and-exact-bytes");check(target==std::vector<BYTE>({1,0,0,0}),"absent-target-prefix");
    check(migration.decide(decision(io.legacy,io.target,1))==std::vector<BYTE>({1,1}),"copied-outcome");check(io.target.bytes==io.legacy.bytes&&io.target.present&&io.completed.present&&io.guard&&io.released,"copy-retains-guard");
    check(io.completed.bytes==migrationMarker(context,io.legacy,false),"context-bound-marker");
    std::vector<std::string> writes;for(const auto& event:io.events)if(event.find("destination-")==0||event.find("marker-")==0)writes.push_back(event);
    check(writes==std::vector<std::string>({"marker-load","destination-snapshot","destination-create","destination-write","destination-flush-1","destination-readback","destination-publish","destination-flush-2","destination-published-readback","marker-create","marker-write","marker-flush-1","marker-readback","marker-publish","marker-flush-2","marker-published-readback"}),"production-publish-flush-readback-order");
    rejected([&]{migration.decide(decision(io.legacy,io.target,2));},"duplicate-decision");
}
void decisionFailures(){
    for(unsigned scenario=0;scenario<11;++scenario){MemoryIo io;ObservingMigration migration(context,io);frames(migration);auto bytes=decision(io.legacy,io.target,1);
        if(scenario==0)bytes.pop_back();if(scenario==1)bytes.push_back(0);if(scenario==2)bytes[0]=2;if(scenario==3)bytes[1]=4;if(scenario==4)bytes[2]=1;if(scenario==5)bytes[3]=1;if(scenario==6)bytes[4]^=1;if(scenario==7)bytes[36]=1;if(scenario==8)bytes[1]=3;if(scenario==9)bytes[2]=2;if(scenario==10)bytes[1]=2;
        rejected([&]{migration.decide(bytes);},"bad-decision-accepted");noPublication(io);rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"failed-decision-retried");
    }
    {MemoryIo io;ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.decide(decision(io.legacy,io.target,0));},"blocked-action-accepted");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"decision-before-snapshots");rejected([&]{migration.sourceFrame();},"reordered-transaction-reused");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);rejected([&]{migration.destinationFrame();},"destination-before-source");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);migration.sourceFrame();rejected([&]{migration.sourceFrame();},"duplicate-source");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.destinationFrame();},"duplicate-destination");noPublication(io);}
}
void wireBounds(){
    MemoryIo io;io.legacy.bytes=std::string(observingMigrationBytes,' ');io.target={io.legacy.bytes,true};ObservingMigration migration(context,io);
    const auto source=migration.sourceFrame(),target=migration.destinationFrame();check(source.size()==32772&&target.size()==32772&&source.size()+target.size()==65544,"four-byte-prefix-maxima");
    check(std::vector<BYTE>(source.begin(),source.begin()+4)==std::vector<BYTE>({1,0,0,0})&&std::vector<BYTE>(target.begin(),target.begin()+4)==std::vector<BYTE>({1,1,0,0}),"both-prefix-exact-four");
    check(source.size()==io.legacy.bytes.size()+4&&target.size()==io.target.bytes.size()+4,"prefix-adds-four");
    const auto bytes=decision(io.legacy,io.target,0);const auto a=hashRaw(io.legacy.bytes),b=hashRaw(io.target.bytes);check(bytes.size()==68&&bytes[0]==1&&bytes[1]==0&&bytes[2]==1&&bytes[3]==0,"decision-prefix-and-total");
    check(std::equal(a.begin(),a.end(),bytes.begin()+4)&&std::equal(b.begin(),b.end(),bytes.begin()+36),"decision-hash-offsets-4-36");
    // This valid-UTF8 but invalid JSON is rejected by trusted Main's planner;
    // native enforces that blocked decision without publishing any bytes.
    rejected([&]{migration.decide(bytes);},"invalid-json-blocked-decision");noPublication(io);
    for(const auto& raw:std::vector<std::string>{"",std::string(observingMigrationBytes+1,' '),std::string("\xc3\x28",2)}){
        MemoryIo invalid;invalid.legacy.bytes=raw;rejected([&]{ObservingMigration bad(context,invalid);},"invalid-source-snapshot");noPublication(invalid);
        MemoryIo destination;destination.target={raw,true};rejected([&]{ObservingMigration bad(context,destination);},"invalid-destination-snapshot");noPublication(destination);
    }
}
void identicalAndCompleted(){
    MemoryIo io;io.target={io.legacy.bytes,true};{ObservingMigration migration(context,io);frames(migration);check(migration.decide(decision(io.legacy,io.target,2))==std::vector<BYTE>({1,2}),"identical-existing-outcome");check(io.calls("destination-create")==0&&io.calls("marker-create")==1,"identical-no-destination-rewrite");}
    const auto marker=io.completed.bytes;io.restart();io.target.bytes=document(9);
    {ObservingMigration migration(context,io);const auto source=migration.sourceFrame();migration.destinationFrame();check(source[1]==1&&source[2]==0,"completed-existing-source-prefix");check(migration.decide(decision(io.legacy,io.target,3))==std::vector<BYTE>({1,3}),"adopt-valid-native-edits");check(io.completed.bytes==marker&&io.target.bytes==document(9)&&io.calls("destination-create")==0&&io.calls("marker-create")==0,"completed-no-rewrite");}
    for(BYTE action:std::array<BYTE,2>{1,2}){io.restart();ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.decide(decision(io.legacy,io.target,action));},"completed-wrong-action");noPublication(io);}
    {MemoryIo conflict;conflict.target={document(8),true};ObservingMigration migration(context,conflict);frames(migration);rejected([&]{migration.decide(decision(conflict.legacy,conflict.target,2));},"conflicting-destination-overwrite");noPublication(conflict);}
    {MemoryIo conflict;conflict.target={conflict.legacy.bytes,true};ObservingMigration migration(context,conflict);frames(migration);rejected([&]{migration.decide(decision(conflict.legacy,conflict.target,1));},"copy-replaces-existing");noPublication(conflict);}
}
void sourceReservation(){
    MemoryIo io;io.legacyPresent=false;
    {ObservingMigration migration(context,io);const auto source=migration.sourceFrame();migration.destinationFrame();check(source[1]==0&&source[2]==1&&io.legacy.bytes==document(0)&&io.guard&&io.reservations==1,"absent-source-reserved-valid-empty");migration.decide(decision(io.legacy,io.target,1));check(migrationMarkerOrigin(io.completed.bytes),"historical-origin-reserved");}
    io.restart();
    {ObservingMigration migration(context,io);const auto source=migration.sourceFrame();migration.destinationFrame();check(source[1]==1&&source[2]==0,"completed-origin-is-current-existing");migration.decide(decision(io.legacy,io.target,3));check(io.reservations==1&&migrationMarkerOrigin(io.completed.bytes),"historical-origin-remains-reserved");}
    {MemoryIo partial;partial.legacyPresent=false;partial.failAt="source-create-new";rejected([&]{ObservingMigration bad(context,partial);},"reservation-cutpoint");check(partial.legacyPresent&&partial.legacy.bytes.empty(),"partial-source-preserved");partial.restart();rejected([&]{ObservingMigration bad(context,partial);},"existing-empty-source-blocked");check(partial.reservations==1,"partial-source-not-recreated");}
    {MemoryIo interrupted;interrupted.legacyPresent=false;interrupted.failAt="source-flush";rejected([&]{ObservingMigration bad(context,interrupted);},"source-flush-cutpoint");interrupted.restart();ObservingMigration migration(context,interrupted);const auto source=migration.sourceFrame();check(source[2]==0&&interrupted.reservations==1,"surviving-valid-source-replanned-existing");}
    {MemoryIo late;late.legacyPresent=false;late.lateCreation=true;rejected([&]{ObservingMigration bad(context,late);},"late-first-create-must-block");check(late.legacy.bytes==document(4)&&late.reservations==0&&!late.guard,"late-source-not-truncated-or-reacquired");noPublication(late);}
}
void markerAndFingerprintFailures(){
    const auto completed=[](){MemoryIo io;io.target={io.legacy.bytes,true};io.completed={migrationMarker(context,io.legacy,false),true};return io;};
    for(unsigned scenario=0;scenario<6;++scenario){auto io=completed();
        if(scenario==0)io.completed.bytes.clear();if(scenario==1)io.completed.bytes.pop_back();if(scenario==2)io.completed.bytes[5]='x';if(scenario==3)io.legacy.identity=std::string(24,'d');if(scenario==4)io.legacy.bytes=document(6);if(scenario==5)io.legacyPresent=false;
        rejected([&]{ObservingMigration bad(context,io);},"marker-or-source-fingerprint-invalid");check(io.reservations==0,"completed-cannot-reserve-new-source");noPublication(io);
    }
    for(const auto& wrong:std::vector<MigrationContext>{{"S-1-5-21-100-200-300-1002",context.state,context.data},{context.owner,std::string(24,'e'),context.data},{context.owner,context.state,std::string(24,'e')}}){auto io=completed();rejected([&]{ObservingMigration bad(wrong,io);},"marker-wrong-owner-context");noPublication(io);}
    {auto io=completed();io.target={};rejected([&]{ObservingMigration bad(context,io);},"completed-destination-absent");noPublication(io);}
    {auto io=completed();io.target={"",true};rejected([&]{ObservingMigration bad(context,io);},"completed-destination-empty");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);frames(migration);io.legacy.bytes=document(8);rejected([&]{migration.decide(decision(MigrationSource{document(7),io.legacy.identity,false},{},1));},"source-changed-after-snapshot");noPublication(io);}
    {MemoryIo io;ObservingMigration migration(context,io);frames(migration);io.target={document(8),true};rejected([&]{migration.decide(decision(io.legacy,{},1));},"destination-appeared-after-snapshot");noPublication(io);}
    {MemoryIo io;io.failAt="source-acquire";rejected([&]{ObservingMigration bad(context,io);},"guard-acquisition-failure");noPublication(io);}
    {MemoryIo io;io.completed={"unexpected",false};rejected([&]{ObservingMigration bad(context,io);},"absent-marker-with-bytes");noPublication(io);}
    {MemoryIo io;io.target={"unexpected",false};rejected([&]{ObservingMigration bad(context,io);},"absent-destination-with-bytes");noPublication(io);}
}
void publicationCutpoints(){
    for(const auto* point:{"destination-create","destination-write","destination-flush-1","destination-readback","destination-publish","destination-flush-2","destination-published-readback",
        "marker-create","marker-write","marker-flush-1","marker-readback","marker-publish","marker-flush-2","marker-published-readback"}){
        MemoryIo io;io.failAt=point;
        {ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"publication-cutpoint-accepted");check(io.guard&&!io.released,"failure-keeps-source-guard");rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"publication-failure-retried-in-session");}
        const bool pending=io.temps[0].exists||io.temps[1].exists;io.restart();
        if(pending){rejected([&]{ObservingMigration bad(context,io);},"leftover-temp-not-blocked");check(io.temps[0].exists||io.temps[1].exists,"leftover-temp-not-deleted");}
        else {const BYTE action=io.completed.present?3:io.target.present?2:1;ObservingMigration retry(context,io);frames(retry);check(retry.decide(decision(io.legacy,io.target,action))==std::vector<BYTE>({1,action}),"cutpoint-replan-by-observed-state");}
    }
    for(const auto* corrupt:{"destination-readback","destination-published-readback","marker-readback","marker-published-readback"}){
        MemoryIo io;io.corruptAt=corrupt;ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"readback-corruption-accepted");check(!io.released&&io.guard,"readback-corruption-no-complete");
    }
    {MemoryIo io;io.raceAtPublish=true;ObservingMigration migration(context,io);frames(migration);rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"publish-no-replace-race");check(io.target.bytes==document(8)&&!io.completed.present&&io.temps[0].exists,"publish-race-preserves-both-target-and-temp");}
    {MemoryIo io;bool alive=true;ObservingMigration migration(context,io,[&]{if(!alive)throw WinError("fake-owner-terminal",ERROR_OPERATION_ABORTED);});frames(migration);alive=false;rejected([&]{migration.decide(decision(io.legacy,io.target,1));},"terminal-owner-stops-publication");noPublication(io);check(io.guard,"terminal-owner-retains-guard");}
}
}
int wmain(){
    try{ordinaryCopy();decisionFailures();wireBounds();identicalAndCompleted();sourceReservation();markerAndFingerprintFailures();publicationCutpoints();emit("{\"passed\":true,\"suite\":\"native-observing-migration-v1\",\"syntheticOnly\":true}");return 0;}
    catch(const WinError& error){emit("{\"passed\":false,\"stage\":\""+std::string(error.what())+"\",\"error\":"+std::to_string(error.code)+"}");return 1;}
    catch(...){emit("{\"passed\":false,\"stage\":\"unexpected-exception\"}");return 1;}
}
