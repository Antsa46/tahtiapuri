#pragma once
#include "transport-wire.h"
#include <atomic>
#include <deque>
#include <mutex>
#include <thread>
#include <exception>
namespace isolation {
// Exactly one thread reads the synchronous owner pipe. The watchdog observes
// only lost, so a blocked owner read cannot also block its hard deadline.
class OwnerInput {
    HANDLE input;transport::Session session;
    std::atomic<bool> stopping{false};
    std::mutex mutex;std::deque<transport::Frame> queue;
    std::thread reader;
    void read() noexcept {
        try {
            uint32_t last=0;size_t count=0,bytes=0;
            while(!stopping.load()) {
                DWORD available=0;
                if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)) throw WinError("owner-eof");
                if(!available){Sleep(2);continue;}
                auto frame=transport::receive(input,session,[this] {
                    if(stopping.load())throw WinError("owner-stopped",ERROR_OPERATION_ABORTED);
                });
                bytes+=transport::headerSize+frame.body.size();
                if(frame.id!=last+1||++count>32||bytes>32768)throw WinError("owner-budget",ERROR_INVALID_DATA);
                last=frame.id;
                const auto op=static_cast<uint16_t>(frame.op);
                const bool empty=frame.body.empty();
                if(!((op==1||op==6||op==11)?empty:op==3?(!empty&&frame.body.size()<=8000):op==4?frame.body.size()==4:false))
                    throw WinError("owner-operation",ERROR_INVALID_DATA);
                std::lock_guard<std::mutex> lock(mutex);
                if(queue.size()>=8)throw WinError("owner-queue",ERROR_INVALID_DATA);
                queue.push_back(std::move(frame));
            }
        } catch(...) {if(!stopping.load())lost=true;}
    }
public:
    std::atomic<bool> lost{false};
    OwnerInput(HANDLE handle,transport::Session value):input(handle),session(value) {
        if(GetFileType(input)!=FILE_TYPE_PIPE)throw WinError("owner-type",ERROR_INVALID_HANDLE);
        reader=std::thread([this]{read();});
    }
    OwnerInput(const OwnerInput&)=delete;
    OwnerInput& operator=(const OwnerInput&)=delete;
    bool take(transport::Frame& frame) {
        std::lock_guard<std::mutex> lock(mutex);
        if(queue.empty())return false;
        frame=std::move(queue.front());queue.pop_front();return true;
    }
    void stop() noexcept {
        if(!reader.joinable())return;
        stopping=true;CancelSynchronousIo(reader.native_handle());
        // This bound also applies after an enclosing launch watchdog has gone.
        // Never destroy fields underneath a live reader or leave an unbounded join.
        if(WaitForSingleObject(reader.native_handle(),1000)!=WAIT_OBJECT_0) {
            TerminateProcess(GetCurrentProcess(),73);
            std::terminate();
        }
        reader.join();
    }
    ~OwnerInput(){stop();}
};
}
