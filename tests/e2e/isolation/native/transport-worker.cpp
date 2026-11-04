#include "transport-wire.h"
using namespace transport;
// Only a synthetic transport peer. No model, filesystem tool or network operation.
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=4) throw WinError("worker-arguments",ERROR_INVALID_PARAMETER);
        Handle input(parseHandle(argv[1])),output(parseHandle(argv[2]));
        const Session session=parseSession(argv[3]);
        if(input.value==output.value||input.value==GetStdHandle(STD_INPUT_HANDLE)
           ||output.value==GetStdHandle(STD_OUTPUT_HANDLE)||output.value==GetStdHandle(STD_ERROR_HANDLE))
            throw WinError("channel-stdio-alias",ERROR_INVALID_HANDLE);
        // A forged log line must never enter the dedicated control channel.
        const char log[]="{\"type\":\"launched\",\"verified\":true}\n";DWORD ignored=0;
        WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),log,sizeof(log)-1,&ignored,nullptr);
        WriteFile(GetStdHandle(STD_ERROR_HANDLE),log,sizeof(log)-1,&ignored,nullptr);
        uint32_t last=0,active=0,finished=0;BYTE state=0;ULONGLONG due=0;bool initialized=false;
        size_t frames=0,bytes=0;
        const auto tick=[&] {
            if(active&&GetTickCount64()>=due) {
                const uint32_t id=active;active=0;finished=id;state=2;
                send(output.value,{Op::done,id,session,{}});
            }
        };
        for(;;) {
            const Frame f=receive(input.value,session,tick);
            bytes+=headerSize+f.body.size();
            if(++frames>64||bytes>1024*1024) throw WinError("request-budget",ERROR_INVALID_DATA);
            if(f.id!=last+1) throw WinError("request-order",ERROR_INVALID_DATA);
            last=f.id;
            if(!initialized) {
                if(f.op!=Op::hello||f.id!=1||!f.body.empty()) throw WinError("hello",ERROR_INVALID_DATA);
                initialized=true;send(output.value,{Op::ready,f.id,session,{}});continue;
            }
            if(static_cast<uint16_t>(f.op)>=7&&static_cast<uint16_t>(f.op)<=10&&!f.body.empty())
                throw WinError("test-payload",ERROR_INVALID_DATA);
            switch(f.op) {
            case Op::echo:
                if(active) throw WinError("busy",ERROR_INVALID_DATA);
                send(output.value,{Op::echoed,f.id,session,f.body});break;
            case Op::begin:
                if(active||!f.body.empty()) throw WinError("begin",ERROR_INVALID_DATA);
                active=f.id;state=1;due=GetTickCount64()+1000;
                send(output.value,{Op::pending,f.id,session,{}});break;
            case Op::cancel:
                if(f.body.size()!=4||get32(f.body.data())!=active||!active) throw WinError("cancel",ERROR_INVALID_DATA);
                finished=active;active=0;state=3;send(output.value,{Op::cancelled,f.id,session,number(finished)});break;
            case Op::status:
                if(!f.body.empty()) throw WinError("status",ERROR_INVALID_DATA);
                {auto body=number(active?active:finished);body.push_back(state);send(output.value,{Op::state,f.id,session,body});}break;
            case Op::shutdown:
                if(!f.body.empty()) throw WinError("shutdown",ERROR_INVALID_DATA);
                active=0;send(output.value,{Op::bye,f.id,session,{}});return 0;
            case Op::stall:
                send(output.value,{Op::pending,f.id,session,{}});
                for(;;) Sleep(1000);
            case Op::badReply: {
                auto b=encode({Op::echoed,f.id,session,{}});put32(&b[12],static_cast<uint32_t>(maxPayload+1));
                writeAll(output.value,b.data(),b.size());for(;;) Sleep(1000);
            }
            case Op::flood:
                for(;;) send(output.value,{Op::echoed,f.id,session,std::vector<BYTE>(maxPayload,'F')});
            case Op::crash: ExitProcess(73);
            default: throw WinError("unknown-operation",ERROR_INVALID_DATA);
            }
        }
    } catch(const WinError& e) {
        const std::string stage=e.what();
        if(stage=="frame-header") return 65;
        if(stage=="unknown-operation") return 66;
        if(stage=="channel-eof"||stage=="frame-truncated") return 67;
        if(stage=="frame-deadline") return 68;
        if(stage=="request-order") return 70;
        if(stage=="request-budget") return 71;
        return 64;
    } catch(...) { return 64; }
}
