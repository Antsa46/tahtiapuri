#include "isolated-launcher.h"
#include "../../../../packages/windows-runtime/native/owner-input.h"
using namespace isolation;
namespace {
const std::atomic<bool>* preparingOwner=nullptr;
void prepare(const std::wstring& root,PSID sid,const std::wstring&,Pins&) {
    std::vector<std::wstring> entries={L"owner.marker",L"package",L"launcher",L"private",L"scratch"};
    if(sid) entries.push_back(L"profile.receipt");
    exactEntries(root,entries);
    exactEntries(root+L"\\package",{L"transport-worker.exe"});
    exactEntries(root+L"\\launcher",{L"transport-host.exe"});
    exactEntries(root+L"\\private",{L"secret.txt"});exactEntries(root+L"\\scratch",{});
    regular(root+L"\\launcher",true);regular(root+L"\\launcher\\transport-host.exe",false);
    const std::wstring image=root+L"\\package\\transport-worker.exe";
    for(const auto& path:{root+L"\\package",root+L"\\private",root+L"\\scratch"}) regular(path,true);
    regular(image,false);regular(root+L"\\private\\secret.txt",false);
    // Protect every owned leaf before replacing the root's inherited ACL.
    // Otherwise Windows can strip inherited owner ACEs from the launcher,
    // marker and receipt even though they are not worker-readable resources.
    setOwnedAcl(root+L"\\launcher",nullptr,0,true);
    setOwnedAcl(root+L"\\launcher\\transport-host.exe",nullptr,0,false);
    setOwnedAcl(root+L"\\owner.marker",nullptr,0,false);
    if(sid) setOwnedAcl(root+L"\\profile.receipt",nullptr,0,false);
    setOwnedAcl(root+L"\\package",sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,true);
    setOwnedAcl(image,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    setOwnedAcl(root+L"\\private",nullptr,0,true);
    setOwnedAcl(root+L"\\private\\secret.txt",nullptr,0,false);
    setOwnedAcl(root+L"\\scratch",sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE,true);
    lowScratch(root+L"\\scratch");
    setOwnedAcl(root,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    if(preparingOwner) {
        emit("{\"type\":\"await-prepare-owner\"}");
        const auto deadline=GetTickCount64()+5000;
        while(!preparingOwner->load()) {
            if(GetTickCount64()>=deadline)throw WinError("prepare-owner-deadline",ERROR_TIMEOUT);
            Sleep(2);
        }
    }
}
const std::vector<std::wstring> cases={L"normal",L"shutdown-pending",L"bad-magic",L"bad-version",L"bad-session",
    L"bad-id",L"bad-op",L"oversize",L"truncated-header",L"truncated-body",L"bad-reply",L"flood",
    L"stalled-reader",L"owner-loss",L"broker-loss",L"crash",L"request-budget",L"generation",L"valid-eof",L"owner-loss-prepare"};
void noPendingResponse(HANDLE input) {
    DWORD bytes=0;
    if(PeekNamedPipe(input,nullptr,0,nullptr,&bytes,nullptr)) {
        if(bytes) throw WinError("unexpected-response",ERROR_INVALID_DATA);
    } else if(GetLastError()!=ERROR_BROKEN_PIPE) throw WinError("response-tail");
}
void exercise(const std::wstring& name,Channel& ch,HANDLE child,Handle& writer,HANDLE job,Watchdog& watchdog) {
    ch.request(Op::hello,1);ch.expect(Op::ready,1);
    if(name==L"normal") {
        ch.request(Op::echo,2);ch.expect(Op::echoed,2);
        std::vector<BYTE> payload(maxPayload,'X');
        ch.request(Op::echo,3,payload);ch.expect(Op::echoed,3,payload);
        const auto fragmented=encode({Op::echo,4,ch.session,{'a','b','c'}});
        for(BYTE b:fragmented){writeAll(writer.value,&b,1);Sleep(1);}
        ch.expect(Op::echoed,4,{'a','b','c'});
        ch.request(Op::begin,5);ch.expect(Op::pending,5);
        ch.request(Op::cancel,6,number(5));ch.expect(Op::cancelled,6,number(5));
        Sleep(1100);auto status=number(5);status.push_back(3);
        ch.request(Op::status,7);ch.expect(Op::state,7,status);
        ch.request(Op::echo,8,{'o','k'});ch.expect(Op::echoed,8,{'o','k'});
        ch.request(Op::shutdown,9);ch.expect(Op::bye,9);
        if(!expectedExit(child,0)) throw WinError("normal-exit",ERROR_INVALID_DATA);
    } else if(name==L"generation") {
        ch.request(Op::begin,2);ch.expect(Op::pending,2);ch.expect(Op::done,2);
        ch.request(Op::shutdown,3);ch.expect(Op::bye,3);
        if(!expectedExit(child,0)) throw WinError("generation-exit",ERROR_INVALID_DATA);
    } else if(name==L"shutdown-pending") {
        ch.request(Op::begin,2);ch.expect(Op::pending,2);
        ch.request(Op::shutdown,3);ch.expect(Op::bye,3);
        if(!expectedExit(child,0)) throw WinError("shutdown-exit",ERROR_INVALID_DATA);
        noPendingResponse(ch.input);
    } else if(name==L"owner-loss"||name==L"broker-loss") {
        ch.request(Op::stall,2);ch.expect(Op::pending,2);
        emit("{\"type\":\"await-owner\",\"pid\":"+std::to_string(GetProcessId(child))+"}");
        while(watchdog.reason.load()==0) Sleep(20);
        if(name!=L"owner-loss"||watchdog.reason.load()!=1||!expectedExit(child,42))
            throw WinError("owner-loss",ERROR_INVALID_DATA);
    } else if(name==L"stalled-reader") {
        ch.request(Op::stall,2);ch.expect(Op::pending,2);
        bool blocked=false;
        try {ch.request(Op::echo,3,std::vector<BYTE>(maxPayload,'S'));}
        catch(const WinError& e){blocked=std::string(e.what())=="channel-write";}
        if(!blocked||watchdog.reason.load()!=2||!expectedExit(child,42))
            throw WinError("write-watchdog",ERROR_INVALID_DATA);
    } else if(name==L"crash") {
        ch.request(Op::crash,2);
        if(!expectedExit(child,73)) throw WinError("crash-exit",ERROR_INVALID_DATA);
    } else if(name==L"bad-reply"||name==L"flood") {
        ch.request(name==L"bad-reply"?Op::badReply:Op::flood,2);bool rejected=false;
        try {
            if(name==L"bad-reply") ch.read();
            else for(;;) ch.expect(Op::echoed,2,std::vector<BYTE>(maxPayload,'F'));
        } catch(const WinError& e) {
            rejected=std::string(e.what())==(name==L"bad-reply"?"frame-header":"response-budget")&&e.code==ERROR_INVALID_DATA;
        }
        if(!rejected||!stopJob(job)||!expectedExit(child,42)) throw WinError("response-rejection",ERROR_INVALID_DATA);
    } else if(name==L"valid-eof") {
        ch.request(Op::echo,2,{'v'});ch.expect(Op::echoed,2,{'v'});close(writer);
        if(!expectedExit(child,67)) throw WinError("valid-eof-exit",ERROR_INVALID_DATA);
        noPendingResponse(ch.input);
    } else if(name==L"request-budget") {
        // The per-worker request budget is independent of the host response budget.
        for(uint32_t id=2;id<=64;++id) {
            ch.request(Op::echo,id);const auto f=receive(ch.input,ch.session);
            if(f.id!=id||f.op!=Op::echoed||!f.body.empty()) throw WinError("budget-response",ERROR_INVALID_DATA);
        }
        ch.request(Op::echo,65);
        if(!expectedExit(child,71)) throw WinError("request-budget-exit",ERROR_INVALID_DATA);
        noPendingResponse(ch.input);
    } else {
        auto frame=encode({Op::echo,2,ch.session,{'x','y'}});
        if(name==L"bad-magic") frame[0]='?';
        else if(name==L"bad-version") frame[4]=2;
        else if(name==L"bad-session") frame[16]^=0xff;
        else if(name==L"bad-id") put32(&frame[8],1);
        else if(name==L"bad-op"){frame[6]=0xff;frame[7]=0xff;}
        else if(name==L"oversize") put32(&frame[12],static_cast<uint32_t>(maxPayload+1));
        else if(name==L"truncated-header") frame.resize(20);
        else if(name==L"truncated-body") frame.resize(headerSize+1);
        else throw WinError("case",ERROR_INVALID_PARAMETER);
        writeAll(writer.value,frame.data(),frame.size());close(writer);
        const DWORD expected=name==L"bad-id"?70:name==L"bad-op"?66:
            (name==L"truncated-header"||name==L"truncated-body")?67:65;
        if(!expectedExit(child,expected)) throw WinError("request-rejection",ERROR_INVALID_DATA);
        noPendingResponse(ch.input);
    }
}
}

int wmain(int argc,wchar_t** argv) {
    std::unique_ptr<OwnerInput> owner;
    if(argc==6&&std::wstring(argv[5])==L"owner-loss-prepare") {
        owner=std::make_unique<OwnerInput>(GetStdHandle(STD_INPUT_HANDLE),Session{});preparingOwner=&owner->lost;
    }
    const Experiment spec{L"tahtiapuri.t09h.","TAHTIAPURI_T09H_TRANSPORT_ONLY",L"transport-worker.exe",256*1024*1024,cases,
        [](const std::wstring& name)->DWORD{return name==L"stalled-reader"?5000:15000;},prepare,exercise,preparingOwner};
    return isolation::run(argc,argv,spec);
}
