#include "../../../../packages/windows-runtime/native/owner-input.h"
#include "../../../../packages/windows-runtime/native/isolated-launcher.h"
using namespace transport;
using namespace isolation;
namespace {
struct Pipe {
    Handle input,output;
    Pipe(){if(!CreatePipe(&input.value,&output.value,nullptr,4096))throw WinError("test-pipe");}
};
template<class Fn> void until(Fn ready,DWORD ms=1000) {
    const auto end=GetTickCount64()+ms;
    while(!ready()){if(GetTickCount64()>=end)throw WinError("test-deadline");Sleep(2);}
}
void require(bool value){if(!value)throw WinError("test-assertion",ERROR_INVALID_DATA);}
void passed(const char* name){emit(std::string("{\"type\":\"owner-input\",\"passed\":true,\"case\":\"")+name+"\"}");}
}
int wmain() {
    try {
        const Session session{};
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            send(pipe.output.value,{Op::hello,1,session,{}});
            Frame frame{};until([&]{return owner.take(frame);});
            require(frame.op==Op::hello&&frame.id==1&&frame.body.empty());
            close(pipe.output);until([&]{return owner.lost.load();});owner.stop();passed("frame-and-owner-eof");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            auto data=encode({Op::hello,1,session,{}});
            writeAll(pipe.output.value,data.data(),3);
            until([&]{return owner.lost.load();},4000);owner.stop();passed("partial-frame-deadline");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            Session wrong=session;wrong[0]=1;send(pipe.output.value,{Op::hello,1,wrong,{}});
            until([&]{return owner.lost.load();});owner.stop();passed("wrong-session");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            send(pipe.output.value,{Op::echo,1,session,{}});
            until([&]{return owner.lost.load();});owner.stop();passed("unknown-owner-operation");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            for(uint32_t n=1;n<=9;++n)send(pipe.output.value,{Op::hello,n,session,{}});
            until([&]{return owner.lost.load();});owner.stop();passed("bounded-owner-queue");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            require(!owner.closingRequested());send(pipe.output.value,{Op::shutdown,1,session,{}});
            until([&]{return owner.closingRequested();});
            Frame frame{};require(owner.take(frame)&&frame.op==Op::shutdown&&!owner.closingRequested());
            owner.stop();passed("queued-shutdown-visible-during-prepare");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            auto data=encode({Op::hello,1,session,{}});
            writeAll(pipe.output.value,data.data(),3);Sleep(20);
            const auto start=GetTickCount64();owner.stop();
            require(GetTickCount64()-start<1000&&!owner.lost);passed("stop-partial-reader");
        }
        {
            Pipe pipe;OwnerInput owner(pipe.input.value,session);
            Handle job(CreateJobObjectW(nullptr,nullptr));require(job.value!=nullptr);
            auto data=encode({Op::hello,1,session,{}});
            writeAll(pipe.output.value,data.data(),3);
            {
                Watchdog watchdog(job.value,100,&owner.lost);
                until([&]{return watchdog.reason.load()!=0;});
                require(watchdog.reason==2);owner.stop();
            }
            passed("watchdog-independent-of-owner-read");
        }
        return 0;
    } catch(...) {return 1;}
}
