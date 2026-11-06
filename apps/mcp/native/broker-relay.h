#pragma once
#include "broker-wire.h"
#include "main-bootstrap.h"

namespace mcp_runtime {
// Routing only. This class cannot emit CLEAN or touch a process, file or token.
// Only the broker's independently verified lifecycle may send CLEAN to Main.
class BrokerRelay {
    const std::array<uint8_t,16> generation;
    std::function<void(BrokerFrame)> toMain,toWorker;
    std::function<void(Bytes)> toHost;
    DevelopmentLines lines;
    bool accepted_=false,ready_=false,stopping_=false;
public:
    BrokerRelay(const MainBootstrap& bootstrap,std::function<void(BrokerFrame)> main,
        std::function<void(BrokerFrame)> worker,std::function<void(Bytes)> host)
        :generation(bootstrap.generation),toMain(std::move(main)),toWorker(std::move(worker)),toHost(std::move(host)){}
    bool accepted()const{return accepted_;}
    bool ready()const{return ready_;}
    bool stopping()const{return stopping_;}
    void check(uint64_t now)const{if(!stopping_)lines.check(now);}
    void stop(){stopping_=true;}
    void main(BrokerFrame frame){
        validateFrame(Direction::FromMain,frame.kind,frame.body.size());
        if(frame.kind==5){if(!accepted_)throw WireError("stop-before-accept");stop();return;}
        if(frame.kind==2){
            if(accepted_||stopping_||!std::equal(frame.body.begin(),frame.body.end(),generation.begin()))throw WireError("accept-generation");
            accepted_=true;return;
        }
        if(!accepted_||!ready_)throw WireError("response-before-ready");
        if(stopping_)return;
        if(!validUtf8(frame.body))throw WireError("response-utf8");
        // A maximum-size JSON response plus LF is larger than one TMCP frame.
        // Keep it a stream: never enlarge the worker's fixed input-frame bound.
        if(frame.body.size()==65536){toWorker({2,std::move(frame.body)});if(!stopping_)toWorker({2,Bytes{'\n'}});}
        else{frame.body.push_back('\n');toWorker({2,std::move(frame.body)});}
    }
    void worker(BrokerFrame frame,uint64_t now){
        validateFrame(Direction::FromWorker,frame.kind,frame.body.size());
        if(stopping_)return;
        if(!accepted_)throw WireError("worker-before-main-accept");
        if(frame.kind==4){if(ready_)throw WireError("duplicate-worker-ready");ready_=true;return;}
        if(!ready_)throw WireError("worker-data-before-ready");
        if(frame.kind==1)toHost(std::move(frame.body));
        else lines.write(frame.body,now,[this](Bytes line){if(!stopping_)toMain({3,std::move(line)});});
    }
    void host(Bytes bytes){
        if(!accepted_||!ready_||stopping_)throw WireError("host-admission");
        validateFrame(Direction::ToWorker,1,bytes.size());toWorker({1,std::move(bytes)});
    }
    void workerEnd()const{lines.end();}
};
}
