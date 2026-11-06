#pragma once
#include "broker-wire.h"
#include "../../../packages/windows-runtime/native/common.h"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

namespace mcp_runtime {
inline uint64_t clockNow(){return GetTickCount64();}
using BrokerClock=uint64_t(*)();
inline void requireIoBudget(uint64_t deadline,const std::atomic<bool>* stopped,BrokerClock now){
    if(stopped&&stopped->load())throw WinError("mcp-io-cancelled",ERROR_OPERATION_ABORTED);
    if(now()>=deadline)throw WinError("mcp-io-deadline",ERROR_TIMEOUT);
}
inline void closeNative(Handle& handle){if(handle.value&&handle.value!=INVALID_HANDLE_VALUE)CloseHandle(handle.value);handle.value=nullptr;}
// Every overlapped operation retains its buffer and OVERLAPPED until completion.
// If Windows does not acknowledge cancellation, exit without a CLEAN claim.
inline DWORD overlappedIo(HANDLE pipe,uint8_t* bytes,DWORD size,bool write,uint64_t deadline,const std::atomic<bool>* stopped=nullptr,BrokerClock now=clockNow){
    requireIoBudget(deadline,stopped,now);
    Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!event.value)throw WinError("mcp-io-event");
    OVERLAPPED operation={};operation.hEvent=event.value;DWORD transferred=0;
    const BOOL immediate=write?WriteFile(pipe,bytes,size,&transferred,&operation):ReadFile(pipe,bytes,size,&transferred,&operation);
    if(!immediate&&GetLastError()!=ERROR_IO_PENDING)throw WinError("mcp-overlapped-start");
    if(!immediate){
        for(;;){
            const DWORD wait=WaitForSingleObject(event.value,10);if(wait==WAIT_OBJECT_0)break;
            if(wait!=WAIT_TIMEOUT||(stopped&&stopped->load())||now()>=deadline){
                CancelIoEx(pipe,&operation);
                if(WaitForSingleObject(event.value,1000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),74);
                // Completion has been observed even if cancellation lost a race.
                DWORD ignored=0;GetOverlappedResult(pipe,&operation,&ignored,FALSE);
                throw WinError("mcp-overlapped-cancelled",ERROR_OPERATION_ABORTED);
            }
        }
    }
    if(!GetOverlappedResult(pipe,&operation,&transferred,FALSE))throw WinError("mcp-overlapped-result");
    // Even a signalled or immediately successful operation can be observed
    // late. Its storage is now safe to release, but its result is not success.
    requireIoBudget(deadline,stopped,now);
    if(!transferred)throw WinError("mcp-pipe-zero",ERROR_BROKEN_PIPE);return transferred;
}
class BrokerWatchdog {
    std::atomic<bool> stopped{false};std::thread thread;
public:
    std::atomic<uint64_t> deadline{0};
    BrokerWatchdog(){thread=std::thread([this]{while(!stopped.load()){const auto end=deadline.load();if(end&&clockNow()>=end)TerminateProcess(GetCurrentProcess(),74);Sleep(10);}});}
    ~BrokerWatchdog(){stopped.store(true);if(thread.joinable())thread.join();}
};
class BrokerWriter {
    struct Item{Bytes bytes;uint64_t deadline;};
    HANDLE pipe;bool overlapped;size_t frameLimit;BrokerClock monotonicNow;
    std::mutex mutex;std::condition_variable changed;std::deque<Item> queue;
    size_t held=0,count=0;std::atomic<bool> stopped{false},fault{false};std::atomic<uint64_t> activeDeadline{0};
    std::thread thread;uint32_t sequence=1;
public:
    BrokerWriter(HANDLE target,bool async,size_t maximumFrames,BrokerClock clock=clockNow):pipe(target),overlapped(async),frameLimit(maximumFrames),monotonicNow(clock){
        thread=std::thread([this]{
            try{
                for(;;){
                    Item item;
                    {std::unique_lock<std::mutex> lock(mutex);changed.wait(lock,[&]{return stopped.load()||!queue.empty();});if(stopped.load())return;
                        item=std::move(queue.front());queue.pop_front();activeDeadline.store(item.deadline);}
                    size_t offset=0;
                    while(offset<item.bytes.size()){
                        requireIoBudget(item.deadline,&stopped,monotonicNow);
                        DWORD sent=0;const auto length=static_cast<DWORD>(item.bytes.size()-offset);
                        if(overlapped)sent=overlappedIo(pipe,item.bytes.data()+offset,length,true,item.deadline,&stopped,monotonicNow);
                        else if(!WriteFile(pipe,item.bytes.data()+offset,length,&sent,nullptr)||!sent)throw WinError("mcp-write");
                        requireIoBudget(item.deadline,&stopped,monotonicNow);
                        offset+=sent;
                    }
                    {std::lock_guard<std::mutex> lock(mutex);
                        // The reservation covers physical completion AND its
                        // timely observation, including waiting for this lock.
                        requireIoBudget(item.deadline,&stopped,monotonicNow);
                        held-=item.bytes.size();--count;activeDeadline.store(0);}
                }
            }catch(...){fault.store(true);}
        });
    }
    bool failed()const{return fault.load();}
    bool idle(){std::lock_guard<std::mutex> lock(mutex);return !count;}
    void check(uint64_t now){
        if(fault.load())throw WinError("mcp-writer-failed",ERROR_BROKEN_PIPE);
        const auto active=activeDeadline.load();if(active&&now>=active)throw WinError("mcp-write-deadline",ERROR_TIMEOUT);
        std::lock_guard<std::mutex> lock(mutex);if(!queue.empty()&&now>=queue.front().deadline)throw WinError("mcp-queue-deadline",ERROR_TIMEOUT);
    }
    void bytes(Bytes bytes){
        if(bytes.empty()||bytes.size()>524288)throw WinError("mcp-write-size",ERROR_BUFFER_OVERFLOW);
        std::lock_guard<std::mutex> lock(mutex);
        if(stopped.load()||fault.load()||count>=frameLimit||held>524288-bytes.size())throw WinError("mcp-write-admission",ERROR_BUFFER_OVERFLOW);
        held+=bytes.size();++count;queue.push_back({std::move(bytes),monotonicNow()+2000});changed.notify_one();
    }
    void frame(Direction direction,BrokerFrame frame){auto encoded=encodeBrokerFrame(direction,frame,sequence);bytes(std::move(encoded));++sequence;}
    void stop(){
        stopped.store(true);changed.notify_all();if(!thread.joinable())return;
        CancelSynchronousIo(thread.native_handle());
        if(WaitForSingleObject(thread.native_handle(),2200)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),74);
        thread.join();
    }
    ~BrokerWriter(){stop();}
};
// Poll one bounded chunk. EOF is separate from a truncated-frame decision.
inline bool pollPipe(HANDLE pipe,bool overlapped,size_t cap,const std::function<void(const uint8_t*,size_t)>& consume){
    DWORD available=0;
    if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){
        const DWORD error=GetLastError();if(error==ERROR_BROKEN_PIPE||error==ERROR_PIPE_NOT_CONNECTED)return false;throw WinError("mcp-peek",error);
    }
    if(!available)return true;
    Bytes bytes(std::min<size_t>(available,cap));DWORD got=0;
    if(overlapped)got=overlappedIo(pipe,bytes.data(),static_cast<DWORD>(bytes.size()),false,clockNow()+2000);
    else if(!ReadFile(pipe,bytes.data(),static_cast<DWORD>(bytes.size()),&got,nullptr)||!got)throw WinError("mcp-read");
    consume(bytes.data(),got);return true;
}
// A process exit is independent of stdout EOF: buffered bytes may still be
// unread. One fixed close budget covers both observations and the full frame.
inline void awaitWorkerClose(HANDLE output,HANDLE error,BrokerReader& reader,bool& outputEnded,
    BrokerWriter& writer,size_t& stderrBytes,const std::function<bool()>& exited,uint64_t deadline){
    bool errorEnded=false;
    for(;;){
        requireIoBudget(deadline,nullptr,clockNow);
        writer.check(clockNow());reader.check(clockNow());
        const bool processExited=exited();
        if(!outputEnded&&!pollPipe(output,false,65536,[&](const uint8_t* bytes,size_t size){
            reader.write(bytes,size,clockNow(),[](BrokerFrame){});
        })){
            reader.end();outputEnded=true;
        }
        if(!errorEnded&&!pollPipe(error,false,1024,[&](const uint8_t*,size_t size){
            stderrBytes+=size;if(stderrBytes>16384)throw WinError("mcp-stderr-bound",ERROR_BUFFER_OVERFLOW);
        }))errorEnded=true;
        if(processExited&&outputEnded&&errorEnded&&writer.idle()){
            reader.end();writer.check(clockNow());requireIoBudget(deadline,nullptr,clockNow);return;
        }
        Sleep(2);
    }
}
}
