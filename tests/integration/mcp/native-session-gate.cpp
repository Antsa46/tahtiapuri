// Test-only owner actor. Not packaged, not an OS inspector: no worker,
// AppContainer profile, Job, model, network or worker-token inspection is performed.
#include "../../../apps/mcp/native/broker-session.h"
#include "../../../apps/mcp/native/broker-io.h"
#include <cstdio>

namespace {
using namespace mcp_runtime;
struct Input {
    std::array<uint8_t,bootstrapBytes> bytes={};
    ~Input(){SecureZeroMemory(bytes.data(),bytes.size());}
    void prefix(){
        size_t used=0;
        while(used<bytes.size()){
            DWORD count=0;
            if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes.data()+used,static_cast<DWORD>(bytes.size()-used),&count,nullptr)||!count)
                throw WinError("session-probe-prefix",ERROR_INVALID_DATA);
            used+=count;
        }
    }
};
void eof(){
    uint8_t extra=0;DWORD count=0;
    const BOOL ok=ReadFile(GetStdHandle(STD_INPUT_HANDLE),&extra,1,&count,nullptr);
    if((!ok&&GetLastError()!=ERROR_BROKEN_PIPE)||count)throw WinError("session-probe-extra",ERROR_INVALID_DATA);
}
void gate(){
    uint8_t value=0;DWORD count=0;
    if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&value,1,&count,nullptr)||count!=1)
        throw WinError("session-probe-control",ERROR_INVALID_DATA);
    eof();
    if(value=='X')throw WinError("session-probe-interrupted",ERROR_OPERATION_ABORTED);
    if(value!='R')throw WinError("session-probe-control",ERROR_INVALID_DATA);
}
struct TicketGuard{
    MainBootstrap& value;
    ~TicketGuard(){SecureZeroMemory(value.launchToken.data(),value.launchToken.size());}
};
}
int wmain(int argc,wchar_t** argv){
    using namespace mcp_runtime;
    if(argc!=3)return 64;
    const std::wstring mode=argv[1];
    if(mode!=L"--prepare"&&mode!=L"--seal"&&mode!=L"--publish"&&mode!=L"--publish-hold"&&mode!=L"--admit-hold"&&mode!=L"--protect-session")return 64;
    const bool hold=mode==L"--publish-hold"||mode==L"--admit-hold";
    const auto deadline=clockNow()+(hold?8000:5000);
    BrokerWatchdog watchdog;watchdog.deadline.store(deadline);
    try{
        for(DWORD type:{STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE})
            if(GetFileType(GetStdHandle(type))!=FILE_TYPE_PIPE)throw WinError("session-probe-pipe",ERROR_INVALID_HANDLE);
        if(mode==L"--admit-hold"){
            auto bootstrap=readMainBootstrapFile(argv[2]);TicketGuard secret{bootstrap};
            BootstrapDirectoryGuard control(argv[2]);
            emit("admission-starting");
            BrokerSessionAdmission admission(control,bootstrap,deadline);
            SecureZeroMemory(bootstrap.launchToken.data(),bootstrap.launchToken.size());
            emit("admitted");gate();admission.close();emit("admission-complete");return 0;
        }
        if(mode==L"--protect-session"){
            eof();BootstrapDirectoryGuard control(argv[2]);
            BootstrapPin file(control.root+L"\\"+sessionRecordLeaf,false,READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES);
            requireBootstrapAcl(file.handle.value,control.owner,false);
            // More restrictive fixture ACL, still only owner/SYSTEM. The native
            // session policy must reject its wrong inheritance/protection.
            resourceAcl(file,control.owner,nullptr,0,false,true);
            closeBootstrapHandle(file);emit("session-protected");return 0;
        }
        Input input;input.prefix();
        auto bootstrap=decodeMainBootstrap(input.bytes.data(),input.bytes.size());TicketGuard secret{bootstrap};
        if(!hold)eof();
        if(mode==L"--prepare")prepareBrokerSession(argv[2],bootstrap);
        else if(mode==L"--seal")sealBrokerSession(argv[2],bootstrap);
        else if(mode==L"--publish")publishBrokerSession(argv[2],input.bytes);
        else publishBrokerSession(argv[2],input.bytes,[]{emit("published-held");gate();});
        emit(mode==L"--prepare"?"session-prepared":mode==L"--seal"?"session-sealed":"publisher-complete");return 0;
    }catch(const WinError& e){fprintf(stderr,"{\"stage\":\"%s\",\"code\":%lu}\n",e.what(),e.code);return 1;}
    catch(const JournalError& e){fprintf(stderr,"{\"stage\":\"%s\",\"code\":%lu}\n",e.what(),DWORD(ERROR_INVALID_DATA));return 1;}
    catch(...){fputs("{\"stage\":\"session-probe-internal\",\"code\":13}\n",stderr);return 1;}
}
