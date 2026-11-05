#include "engine.h"
#include <mutex>
#include <thread>
using namespace native_model;
namespace {
class Worker {
    Engine engine;std::atomic<bool> cancel{false},finished{false};std::thread thread;
    std::mutex mutex;std::vector<Frame> events;Session session;Outcome outcome;
    std::atomic<bool> loadedModel{false};
    void post(Op op,uint32_t id,std::vector<BYTE> body={}) {
        std::lock_guard<std::mutex> lock(mutex);
        if(events.size()>=4)throw WinError("event-budget",ERROR_INVALID_DATA);
        events.push_back({op,id,session,std::move(body)});
    }
    void fail(uint32_t id,const char* stage,DWORD code) {
        auto body=words({code});body.insert(body.end(),stage,stage+strlen(stage));post(failed,id,std::move(body));
    }
public:
    explicit Worker(Session value):session(value){events.reserve(4);}
    ~Worker(){cancel=true;if(thread.joinable())thread.join();engine.dispose();}
    bool busy()const{return thread.joinable();}
    bool ready()const{return loadedModel.load();}
    bool complete()const{return finished.load();}
    void interrupt(){cancel=true;}
    void join(){thread.join();}
    void dispose(){engine.dispose();}
    std::vector<BYTE> disposalReceipt()const{return words({1,outcome.abortObserved,outcome.reason});}
    void start(bool loading,uint32_t id,std::string prompt={}) {
        if(thread.joinable())throw WinError("busy",ERROR_INVALID_DATA);
        cancel=false;finished=false;
        thread=std::thread([this,loading,id,prompt=std::move(prompt)]{
            try {
                if(loading) {
                    engine.load(cancel);loadedModel=true;
                    auto body=words({contextSize,batchSize,batchSize,1,1,0});
                    body.insert(body.end(),templateHash,templateHash+64);post(loaded,id,std::move(body));
                } else {
                    outcome=engine.generate(prompt,cancel,[this,id]{post(computing,id);});
                    if(outcome.reason==2)outcome.text.clear();
                    auto body=words({outcome.input,outcome.output,outcome.reason,outcome.abortObserved});
                    body.insert(body.end(),outcome.text.begin(),outcome.text.end());post(Op::done,id,std::move(body));
                }
            } catch(const WinError& error) {
                try{fail(id,failureStage(error,loading,cancel.load()),error.code);}catch(...){}
            } catch(...) {try{fail(id,"internal",ERROR_INVALID_DATA);}catch(...){}}
            finished=true;
        });
    }
    std::vector<Frame> take(bool terminalAllowed) {
        std::lock_guard<std::mutex> lock(mutex);std::vector<Frame> result;
        for(auto it=events.begin();it!=events.end();) {
            if(terminalAllowed||it->op==computing){result.push_back(std::move(*it));it=events.erase(it);}else ++it;
        }
        return result;
    }
};
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=4)throw WinError("arguments",ERROR_INVALID_PARAMETER);
        Handle input(parseHandle(argv[1])),output(parseHandle(argv[2]));const auto session=parseSession(argv[3]);
        if(input.value==output.value||input.value==GetStdHandle(STD_INPUT_HANDLE)||
            output.value==GetStdHandle(STD_OUTPUT_HANDLE)||output.value==GetStdHandle(STD_ERROR_HANDLE))throw WinError("channel-alias",ERROR_INVALID_DATA);
        Worker worker(session);uint32_t last=0,shutdownId=0;bool hello=false,loadAttempted=false,generated=false;
        size_t frames=0,bytes=0;const auto deadline=GetTickCount64()+180000;
        for(;;) {
            // Only this thread writes protocol bytes; llama callbacks enqueue.
            for(auto& event:worker.take(false))if(!shutdownId)send(output.value,event);
            if(worker.busy()&&worker.complete()) {
                worker.join();
                for(auto& event:worker.take(true))if(!shutdownId)send(output.value,event);
            }
            if(shutdownId&&!worker.busy()) {
                worker.dispose();send(output.value,{Op::bye,shutdownId,session,worker.disposalReceipt()});return 0;
            }
            if(GetTickCount64()>=deadline)throw WinError("worker-deadline",ERROR_TIMEOUT);
            if(!available(input.value)){Sleep(2);continue;}
            const Frame f=receive(input.value,session);bytes+=headerSize+f.body.size();
            if(++frames>32||bytes>32768||f.id!=last+1)throw WinError("request-order-or-budget",ERROR_INVALID_DATA);
            last=f.id;
            // Shutdown is valid before/during load, during generation and after
            // its terminal event. A late cancellation is not a protocol failure.
            if(f.op==Op::shutdown) {
                if(!f.body.empty())throw WinError("shutdown-request",ERROR_INVALID_DATA);
                if(!shutdownId)shutdownId=f.id;
                worker.interrupt();continue;
            }
            if(shutdownId)throw WinError("closing",ERROR_INVALID_DATA);
            if(!hello) {
                if(f.op!=Op::hello||f.id!=1||!f.body.empty())throw WinError("hello",ERROR_INVALID_DATA);
                hello=true;send(output.value,{Op::ready,f.id,session,{}});continue;
            }
            if(f.op==load) {
                if(!f.body.empty()||loadAttempted||worker.busy())throw WinError("load-request",ERROR_INVALID_DATA);
                loadAttempted=true;worker.start(true,f.id);send(output.value,{Op::pending,f.id,session,{}});
            } else if(f.op==Op::begin) {
                if(f.body.empty()||f.body.size()>inputBytes||!worker.ready()||generated||worker.busy())throw WinError("generation-request",ERROR_INVALID_DATA);
                generated=true;worker.start(false,f.id,std::string(f.body.begin(),f.body.end()));
                send(output.value,{Op::pending,f.id,session,{}});
            } else throw WinError("unknown-operation",ERROR_INVALID_DATA);
        }
    } catch(...) {return 64;}
}
