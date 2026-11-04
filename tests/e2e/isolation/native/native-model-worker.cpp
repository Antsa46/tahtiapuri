#include "native-model-engine.h"
#include "native-model-protocol.h"
#include <mutex>
#include <thread>
using namespace native_model;
namespace {
std::vector<BYTE> fileProbe() {
    const auto package=packageDirectory();const auto root=package.substr(0,package.find_last_of(L"\\"));
    auto attempt=[](const std::wstring& path,DWORD access,DWORD creation) {
        Handle file(CreateFileW(path.c_str(),access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,creation,0,nullptr));
        return file.value==INVALID_HANDLE_VALUE?GetLastError():DWORD(0);
    };
    const DWORD read=attempt(root+L"\\private\\secret.txt",GENERIC_READ,OPEN_EXISTING);
    const DWORD write=attempt(package+L"\\readonly.txt",GENERIC_WRITE,OPEN_EXISTING);
    const auto scratch=root+L"\\scratch\\probe.tmp";const DWORD created=attempt(scratch,GENERIC_WRITE,CREATE_NEW);
    // The restricted worker can create its probe, but trusted owner cleanup deletes it.
    return words({read,write,created});
}
struct Worker {
    Engine engine;std::atomic<bool> cancel{false},finished{false};std::thread thread;
    std::mutex mutex;std::vector<Frame> events;Session session;Outcome outcome;
    std::atomic<bool> loadedModel{false};bool generated=false,success=false;uint32_t job=0;
    explicit Worker(Session value):session(value){events.reserve(4);}
    ~Worker(){cancel=true;if(thread.joinable())thread.join();engine.dispose();}
    void post(Op op,uint32_t id,std::vector<BYTE> body={}) {
        std::lock_guard<std::mutex> lock(mutex);
        if(events.size()>=4)throw WinError("event-budget",ERROR_INVALID_DATA);
        events.push_back({op,id,session,std::move(body)});
    }
    void start(bool loading,uint32_t id) {
        if(thread.joinable())throw WinError("busy",ERROR_INVALID_DATA);
        cancel=false;finished=false;success=false;job=id;
        thread=std::thread([this,loading,id]{
            try {
                if(loading) {
                    engine.load(cancel);loadedModel=true;
                    auto body=words({512,32,32,1,1,0});
                    body.insert(body.end(),templateHash,templateHash+64);
                    const auto checks=fileProbe();body.insert(body.end(),checks.begin(),checks.end());post(loaded,id,std::move(body));
                } else {
                    outcome=engine.generate(cancel,[this,id]{post(computing,id);});
                    auto body=words({outcome.input,outcome.output,outcome.reason,outcome.abortObserved});
                    body.insert(body.end(),outcome.text.begin(),outcome.text.end());post(Op::done,id,std::move(body));
                }
                success=true;
            } catch(const WinError& e) {
                const std::string stage=e.what();try{auto body=words({e.code});body.insert(body.end(),stage.begin(),stage.end());post(failed,id,std::move(body));}catch(...){}
            } catch(...) {try{auto body=words({ERROR_INVALID_DATA});const std::string stage="exception";body.insert(body.end(),stage.begin(),stage.end());post(failed,id,std::move(body));}catch(...){}}
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
        Worker worker(session);uint32_t last=0,cancelId=0,shutdownId=0;bool hello=false;
        size_t frames=0,bytes=0;const auto deadline=GetTickCount64()+180000;
        for(;;) {
            // This thread alone serializes protocol replies. Engine callbacks never write pipes.
            for(auto& event:worker.take(false))if(!shutdownId)send(output.value,event);
            if(worker.thread.joinable()&&worker.finished.load()) {
                worker.thread.join();
                // An event may have been queued immediately before finished became visible.
                for(auto& event:worker.take(true))if(!shutdownId)send(output.value,event);
                if(cancelId) {
                    if(!worker.success||worker.outcome.reason!=2)throw WinError("cancel-too-late",ERROR_INVALID_DATA);
                    send(output.value,{Op::cancelled,cancelId,session,number(worker.job)});cancelId=0;
                }
            }
            if(shutdownId&&!worker.thread.joinable()) {
                worker.engine.dispose();
                send(output.value,{Op::bye,shutdownId,session,words({1,worker.outcome.abortObserved,worker.outcome.reason})});return 0;
            }
            if(GetTickCount64()>=deadline)throw WinError("worker-deadline",ERROR_TIMEOUT);
            if(!available(input.value)){Sleep(2);continue;}
            const Frame f=receive(input.value,session);bytes+=headerSize+f.body.size();
            if(shutdownId||++frames>32||bytes>32768||f.id!=last+1)throw WinError("request-order-or-budget",ERROR_INVALID_DATA);
            last=f.id;
            if(!hello) {
                if(f.op!=Op::hello||f.id!=1||!f.body.empty())throw WinError("hello",ERROR_INVALID_DATA);
                hello=true;send(output.value,{Op::ready,f.id,session,{}});continue;
            }
            if(f.op==load) {
                if(!f.body.empty()||worker.loadedModel||worker.thread.joinable())throw WinError("load-request",ERROR_INVALID_DATA);
                worker.start(true,f.id);send(output.value,{Op::pending,f.id,session,{}});
            } else if(f.op==Op::begin) {
                if(!f.body.empty()||!worker.loadedModel||worker.generated||worker.thread.joinable())throw WinError("generation-request",ERROR_INVALID_DATA);
                worker.generated=true;worker.start(false,f.id);send(output.value,{Op::pending,f.id,session,{}});
            } else if(f.op==Op::cancel) {
                if(f.body!=number(worker.job)||!worker.thread.joinable()||cancelId)throw WinError("cancel-request",ERROR_INVALID_DATA);
                worker.cancel=true;cancelId=f.id;send(output.value,{Op::pending,f.id,session,{}});
            } else if(f.op==Op::shutdown) {
                if(!f.body.empty()||cancelId)throw WinError("shutdown-request",ERROR_INVALID_DATA);
                shutdownId=f.id;worker.cancel=true;
            } else throw WinError("unknown-operation",ERROR_INVALID_DATA);
        }
    } catch(...) {return 64;}
}
