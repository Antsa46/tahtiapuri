#include "../../../apps/mcp/native/broker-relay.h"
#include <iostream>
#include <memory>

namespace {
using namespace mcp_runtime;
void check(bool value,const char* label){if(!value)throw std::runtime_error(label);}
template<class Action> void rejected(Action action,const char* label){try{action();}catch(const WireError&){return;}throw std::runtime_error(label);}
void framing(){
    auto ready=encodeBrokerFrame(Direction::FromWorker,{4,{}},1);BrokerReader reader(Direction::FromWorker);int count=0;
    for(size_t i=0;i<ready.size();++i)reader.write(ready.data()+i,1,100,[&](BrokerFrame frame){check(frame.kind==4&&frame.body.empty(),"ready-frame");++count;});
    check(count==1,"zero-length-ready-not-delivered");reader.end();
    for(const auto direction:{Direction::FromWorker,Direction::FromMain}){
        const auto allowed=direction==Direction::FromWorker?4:2;
        auto header=encodeBrokerFrame(direction,{static_cast<uint8_t>(allowed),direction==Direction::FromWorker?Bytes{}:Bytes(16)},1);
        auto invalid=header;invalid[3]=direction==Direction::FromWorker?'T':'P';
        rejected([&]{BrokerReader r(direction);r.write(invalid.data(),invalid.size(),0,[](BrokerFrame){});},"cross-protocol-header");
        invalid=header;wirePut32(invalid.data()+8,0xffffffff);
        rejected([&]{BrokerReader r(direction);r.write(invalid.data(),16,0,[](BrokerFrame){});},"unchecked-huge-allocation");
        invalid=header;wirePut32(invalid.data()+12,2);
        rejected([&]{BrokerReader r(direction);r.write(invalid.data(),invalid.size(),0,[](BrokerFrame){});},"sequence-skip");
        invalid=header;invalid[7]=1;
        rejected([&]{BrokerReader r(direction);r.write(invalid.data(),invalid.size(),0,[](BrokerFrame){});},"reserved-byte");
    }
    rejected([&]{encodeBrokerFrame(Direction::FromWorker,{6,{}},1);},"worker-forged-clean");
    rejected([&]{encodeBrokerFrame(Direction::FromWorker,{3,{}},1);},"worker-forged-close");
    BrokerReader slow(Direction::FromWorker);slow.write(ready.data(),1,100,[](BrokerFrame){});slow.write(ready.data()+1,1,2099,[](BrokerFrame){});
    rejected([&]{slow.check(2100);},"trickle-extended-deadline");rejected([&]{slow.end();},"truncated-header");
}
struct Fixture {
    MainBootstrap bootstrap;std::vector<BrokerFrame> main,worker;std::vector<Bytes> host;
    std::unique_ptr<BrokerRelay> relay;std::function<void()> mainEffect,workerEffect;
    Fixture(){bootstrap.generation.fill(0x37);relay=std::make_unique<BrokerRelay>(bootstrap,[&](BrokerFrame f){main.push_back(std::move(f));if(mainEffect)mainEffect();},
        [&](BrokerFrame f){worker.push_back(std::move(f));if(workerEffect)workerEffect();},[&](Bytes b){host.push_back(std::move(b));});}
    void accepted(){relay->main({2,Bytes(16,0x37)});}
    void ready(){accepted();relay->worker({4,{}},10);}
};
void routing(){
    {Fixture f;rejected([&]{f.relay->worker({4,{}},0);},"worker-before-auth");}
    {Fixture f;rejected([&]{f.relay->main({2,Bytes(16,0x38)});},"wrong-generation");}
    {Fixture f;f.accepted();rejected([&]{f.relay->worker({1,Bytes{'x'}},1);},"worker-before-ready");}
    {Fixture f;f.ready();rejected([&]{f.relay->worker({4,{}},1);},"duplicate-ready");}
    {Fixture f;f.ready();f.relay->worker({2,Bytes{'{','"','x','"',':','"',0xc3}},100);f.relay->worker({2,Bytes{0xa4,'"','}','\n'}},101);
        check(f.main.size()==1&&f.main[0].kind==3&&validUtf8(f.main[0].body),"fragmented-utf8-line");}
    for(const Bytes& bad:{Bytes{0xc0,0xaf,'\n'},Bytes{0xed,0xa0,0x80,'\n'},Bytes{0xf4,0x90,0x80,0x80,'\n'},Bytes{0xc3,'\n'},Bytes{'\n'}}){
        Fixture f;f.ready();rejected([&]{f.relay->worker({2,bad},0);},"invalid-development-utf8");}
    {Fixture f;f.ready();f.relay->worker({2,Bytes{'{'}},0);f.relay->worker({2,Bytes{' '}},1999);rejected([&]{f.relay->check(2000);},"line-trickle");}
    {Fixture f;f.ready();f.relay->worker({2,Bytes(16384,'x')},0);rejected([&]{f.relay->worker({2,Bytes{'x'}},1);},"unbounded-line");}
    {Fixture f;f.ready();f.relay->main({4,Bytes(65536,'x')});check(f.worker.size()==2&&f.worker[0].body.size()==65536&&f.worker[1].body==Bytes{'\n'},"maximum-response-stream-boundary");}
    {Fixture f;f.ready();f.mainEffect=[&]{f.relay->stop();};f.relay->worker({2,Bytes{'{','}','\n','{','}','\n'}},0);check(f.main.size()==1,"request-after-reentrant-stop");}
    {Fixture f;f.ready();f.workerEffect=[&]{f.relay->stop();};f.relay->main({4,Bytes(65536,'x')});check(f.worker.size()==1,"newline-after-reentrant-stop");}
    {Fixture f;f.ready();f.relay->worker({1,Bytes{'T','M','C','T',1,6}},0);check(f.main.empty()&&f.host.size()==1,"worker-data-became-control");f.relay->main({5,{}});f.relay->worker({1,Bytes{'x'}},1);check(f.host.size()==1,"data-after-stop");}
}
}
int main(){try{framing();routing();std::cout<<"{\"passed\":true,\"suite\":\"native-mcp-broker-wire-v1\"}\n";return 0;}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
