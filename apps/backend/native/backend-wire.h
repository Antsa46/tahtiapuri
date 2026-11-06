#pragma once
#include "../../../packages/windows-runtime/native/common.h"
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <thread>

// Production TBIP/2 is independent of the model and experiment protocols.
namespace backend_runtime {
using Nonce = std::array<BYTE,32>;
constexpr size_t headerBytes=56, chunkBytes=65536, ownerAppBytes=65536;
constexpr size_t childAppBytes=16*1024*1024, pendingBytes=256*1024, pendingMessages=64;
enum Kind:uint16_t { Start=1, App=2, CloseInput=3, Kill=4, Heartbeat=5, MigrationDecision=6, Prepared=129,
    Started=130, ChildChunk=131, Result=132, Stderr=133, MigrationSourceFrame=134, MigrationDestinationFrame=135, Migrated=136 };
inline uint64_t now() { return GetTickCount64(); }
inline void closeHandle(Handle& handle) { if(handle.value && handle.value!=INVALID_HANDLE_VALUE) CloseHandle(handle.value); handle.value=nullptr; }
inline uint16_t get16(const BYTE* p) { return uint16_t(p[0])|(uint16_t(p[1])<<8); }
inline uint32_t get32(const BYTE* p) { uint32_t n=0; for(unsigned i=0;i<4;++i) n|=uint32_t(p[i])<<(i*8); return n; }
inline uint64_t get64(const BYTE* p) { uint64_t n=0; for(unsigned i=0;i<8;++i) n|=uint64_t(p[i])<<(i*8); return n; }
inline void put(BYTE* p,uint64_t n,unsigned bytes) { for(unsigned i=0;i<bytes;++i) p[i]=BYTE(n>>(i*8)); }
inline bool lowerHex(const std::wstring& value,size_t length) {
    return value.size()==length && std::all_of(value.begin(),value.end(),[](wchar_t c){return (c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f');});
}
inline Nonce parseNonce(const std::wstring& value) {
    if(!lowerHex(value,64)) throw WinError("nonce",ERROR_INVALID_PARAMETER);
    Nonce nonce={}; auto digit=[](wchar_t c){return c<=L'9'?c-L'0':c-L'a'+10;};
    for(size_t i=0;i<32;++i) nonce[i]=BYTE(digit(value[i*2])*16+digit(value[i*2+1])); return nonce;
}
inline std::wstring nonceText(const Nonce& value) { std::wstring result; for(BYTE b:value){result+=L"0123456789abcdef"[b>>4];result+=L"0123456789abcdef"[b&15];} return result; }
struct Sequence {
    uint64_t next=1; bool exhausted=false;
    uint64_t take() { if(exhausted) throw WinError("sequence-exhausted",ERROR_INVALID_DATA); auto n=next; if(next==UINT64_MAX) exhausted=true; else ++next; return n; }
};
inline std::array<BYTE,headerBytes> header(Kind kind,uint64_t sequence,size_t size,const Nonce& nonce) {
    if(!sequence || size>childAppBytes) throw WinError("frame-encode",ERROR_INVALID_DATA);
    std::array<BYTE,headerBytes> data={}; data[0]='T';data[1]='B';data[2]='I';data[3]='P';
    put(data.data()+4,2,2);put(data.data()+6,kind,2);put(data.data()+8,sequence,8);put(data.data()+16,size,4);
    std::copy(nonce.begin(),nonce.end(),data.begin()+24);return data;
}
struct Frame { Kind kind; uint64_t sequence; size_t size; };
inline Frame decode(const std::array<BYTE,headerBytes>& data,uint64_t sequence,const Nonce& nonce,size_t cap) {
    if(data[0]!='T'||data[1]!='B'||data[2]!='I'||data[3]!='P'||get16(data.data()+4)!=2||!sequence||
        get64(data.data()+8)!=sequence||get32(data.data()+20)!=0||get32(data.data()+16)>cap||
        !std::equal(nonce.begin(),nonce.end(),data.begin()+24)) throw WinError("frame-header",ERROR_INVALID_DATA);
    return {Kind(get16(data.data()+6)),sequence,get32(data.data()+16)};
}
struct FrameClock {
private:
    mutable std::mutex mutex;uint64_t began=0,progress=0;
public:
    void observe() {std::lock_guard<std::mutex> lock(mutex);auto t=now();if(!began)began=t;progress=t;}
    void finish() {std::lock_guard<std::mutex> lock(mutex);began=0;progress=0;}
    bool expired(uint64_t t) const {
        // One snapshot belongs to one frame. The reader may have published a time
        // newer than the supervisor's t; guard subtraction instead of underflowing.
        std::lock_guard<std::mutex> lock(mutex);
        return began&&((t>=began&&t-began>=15000)||(progress&&t>=progress&&t-progress>=2000));
    }
};
inline bool readExact(HANDLE handle,BYTE* out,size_t size,FrameClock& clock,bool eof=false) {
    size_t remaining=size;
    while(remaining) {
        DWORD got=0; BOOL ok=ReadFile(handle,out,static_cast<DWORD>(remaining),&got,nullptr);
        if(!ok || !got) {
            DWORD error=ok?ERROR_BROKEN_PIPE:GetLastError();
            if(eof && remaining==size && error==ERROR_BROKEN_PIPE) return false;
            throw WinError("frame-read",error);
        }
        clock.observe();out+=got;remaining-=got;
    }
    return true;
}
inline void writeAll(HANDLE handle,const BYTE* data,size_t size) {
    while(size) { DWORD sent=0; if(!WriteFile(handle,data,static_cast<DWORD>(size),&sent,nullptr)||!sent) throw WinError("pipe-write");data+=sent;size-=sent; }
}
struct Failure {
    std::atomic<bool> failed{false}; std::mutex mutex; std::string stage;DWORD error=0;
    void fail(const char* name,DWORD code=ERROR_INVALID_DATA) { std::lock_guard<std::mutex> lock(mutex);if(!failed.load()){stage=name;error=code;failed.store(true);} }
    void check() const { if(failed.load()) throw WinError("session-stopped",ERROR_OPERATION_ABORTED); }
};
class IoTask {
    Handle done; std::thread thread; Failure& state;std::atomic<bool> stopping{false};
public:
    IoTask(Failure& failure,std::function<void()> action):state(failure) {
        done.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!done.value) throw WinError("io-event");
        thread=std::thread([this,action=std::move(action)] {try{action();}catch(const WinError& e){if(!stopping.load())state.fail(e.what(),e.code);}catch(...){if(!stopping.load())state.fail("io-exception");}SetEvent(done.value);});
    }
    bool complete() const { return WaitForSingleObject(done.value,0)==WAIT_OBJECT_0; }
    void cancel() { stopping.store(true);if(thread.joinable())CancelSynchronousIo(thread.native_handle()); }
    void join() { if(!thread.joinable())return; if(WaitForSingleObject(done.value,2000)!=WAIT_OBJECT_0){cancel();if(WaitForSingleObject(done.value,1000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),74);}thread.join(); }
    ~IoTask(){cancel();join();}
};
struct Record { Kind kind;std::vector<BYTE> body;bool barrier=false; };
class Queue {
    std::mutex mutex;std::condition_variable changed;std::deque<Record> records;
    size_t held=0,count=0;bool closed=false,aborted=false;
public:
    void push(Record record,bool wait,Failure& state,bool ignoreFailure=false) {
        size_t size=headerBytes+record.body.size();if(size>pendingBytes)throw WinError("queue-item",ERROR_BUFFER_OVERFLOW);
        std::unique_lock<std::mutex> lock(mutex);
        while(!closed&&!aborted&&(held>pendingBytes-size||count>=pendingMessages)) {
            if(!wait)throw WinError("input-backpressure",ERROR_BUFFER_OVERFLOW);
            changed.wait_for(lock,std::chrono::milliseconds(10));if(!ignoreFailure)state.check();
        }
        if(aborted||closed)throw WinError("queue-closed",ERROR_OPERATION_ABORTED);
        if(!ignoreFailure)state.check();records.push_back(std::move(record));held+=size;++count;changed.notify_all();
    }
    bool take(Record& record) {
        std::unique_lock<std::mutex> lock(mutex);changed.wait(lock,[&]{return !records.empty()||closed||aborted;});
        if(aborted)return false;if(records.empty())return false;record=std::move(records.front());records.pop_front();return true;
    }
    void complete(const Record& record) {std::lock_guard<std::mutex> lock(mutex);held-=headerBytes+record.body.size();--count;changed.notify_all();}
    void finish(){std::lock_guard<std::mutex> lock(mutex);closed=true;changed.notify_all();}
    void abort(){std::lock_guard<std::mutex> lock(mutex);aborted=true;changed.notify_all();}
};
class Output {
    Nonce nonce;HANDLE pipe;Failure& failure;std::unique_ptr<IoTask> writer;
public:
    Queue queue;std::atomic<uint64_t> writingSince{0};std::atomic<bool> delivered{false};
    Output(const Nonce& n,HANDLE p,Failure& state):nonce(n),pipe(p),failure(state) {
        writer=std::make_unique<IoTask>(state,[this]{Sequence sequence;Record record;
            while(queue.take(record)) {
                writingSince.store(now());auto first=header(record.kind,sequence.take(),record.body.size(),nonce);
                writeAll(pipe,first.data(),first.size());writeAll(pipe,record.body.data(),record.body.size());
                writingSince.store(0);queue.complete(record);
            }
            delivered.store(true);
        });
    }
    void send(Kind kind,std::vector<BYTE> body={},bool final=false) {
        if(body.size()>chunkBytes)throw WinError("outer-frame-cap",ERROR_BUFFER_OVERFLOW);
        queue.push({kind,std::move(body),false},true,failure,final);
    }
    void json(Kind kind,const std::string& body,bool final=false){send(kind,{body.begin(),body.end()},final);}
    void abort(){queue.abort();writer->cancel();}
    void finish(){queue.finish();writer->join();}
    ~Output(){
        // The writer captures this. Join while queue and both atomics still live;
        // reverse member destruction alone would destroy them before writer.
        abort();writer->join();
    }
};
}
