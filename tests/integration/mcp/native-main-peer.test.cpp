#include "../../../apps/mcp/native/main-peer.h"
#include <bcrypt.h>
#include <iostream>
#pragma comment(lib,"bcrypt.lib")
namespace mr=mcp_runtime;
namespace {
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
template<class Work> void rejects(Work work){bool rejected=false;try{work();}catch(const std::exception&){rejected=true;}check(rejected,"expected rejection");}
template<class Work> void rejectsStage(Work work,const char* stage,DWORD code){
    bool rejected=false;try{work();}catch(const WinError& error){check(error.what()==std::string(stage)&&error.code==code,"unexpected rejection cause");rejected=true;}
    check(rejected,"expected Windows identity rejection");
}
std::array<uint8_t,96> golden(){
    std::array<uint8_t,96> b={};const uint8_t header[]={84,77,66,79,79,84,49,0,1,0,0,0,96,0,0,0,4,3,2,1,0,0,0,0,1,2,3,4,5,6,7,8};
    std::copy(std::begin(header),std::end(header),b.begin());std::fill(b.begin()+32,b.begin()+48,uint8_t{0x11});
    std::fill(b.begin()+48,b.begin()+64,uint8_t{0x22});std::fill(b.begin()+64,b.end(),uint8_t{0x33});return b;
}
struct Fixture {
    mr::MainBootstrap bootstrap;Handle server,event;OVERLAPPED connection={};bool pending=false;
    Fixture(){
        bootstrap.main=mr::queryMainIdentity(GetCurrentProcess());
        check(BCryptGenRandom(nullptr,bootstrap.pipeNonce.data(),16,BCRYPT_USE_SYSTEM_PREFERRED_RNG)>=0,"random");
        const auto name=mr::mainPipeName(bootstrap);
        server.value=CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,1024,1024,0,nullptr);
        check(server.value!=INVALID_HANDLE_VALUE,"create fixture pipe");event.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);check(event.value!=nullptr,"connect event");
        connection.hEvent=event.value;const BOOL connected=ConnectNamedPipe(server.value,&connection);
        if(!connected){const DWORD e=GetLastError();check(e==ERROR_IO_PENDING||e==ERROR_PIPE_CONNECTED,"connect begin");pending=e==ERROR_IO_PENDING;}
    }
    void connected(){
        if(pending){check(WaitForSingleObject(event.value,1000)==WAIT_OBJECT_0,"connect wait");DWORD transferred=0;
            check(GetOverlappedResult(server.value,&connection,&transferred,FALSE)!=FALSE,"connect result");pending=false;}
    }
    void empty(){connected();DWORD available=0;const BOOL ok=PeekNamedPipe(server.value,nullptr,0,nullptr,&available,nullptr);
        check((ok&&available==0)||(!ok&&GetLastError()==ERROR_BROKEN_PIPE),"unexpected pre-auth bytes");}
    ~Fixture(){if(pending){CancelIoEx(server.value,&connection);if(WaitForSingleObject(event.value,1000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),97);}}
};
void exchange(HANDLE handle,void* bytes,DWORD count,bool write){
    Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr));check(event.value!=nullptr,"io event");OVERLAPPED ov={};ov.hEvent=event.value;DWORD transferred=0;
    BOOL ok=write?WriteFile(handle,bytes,count,&transferred,&ov):ReadFile(handle,bytes,count,&transferred,&ov);
    if(!ok){check(GetLastError()==ERROR_IO_PENDING,"io begin");if(WaitForSingleObject(event.value,1000)!=WAIT_OBJECT_0){
        CancelIoEx(handle,&ov);if(WaitForSingleObject(event.value,1000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),98);throw std::runtime_error("io timeout");}
        check(GetOverlappedResult(handle,&ov,&transferred,FALSE)!=FALSE,"io result");}
    check(transferred==count,"io length");
}
}
int main(){
    try {
        const auto bytes=golden();const auto parsed=mr::decodeMainBootstrap(bytes.data(),bytes.size());
        check(parsed.main.pid==0x01020304&&parsed.main.creationTime==0x0807060504030201ULL,"cross-language identity");
        check(parsed.launchToken[31]==0x33&&parsed.generation[0]==0x22,"cross-language token");
        check(mr::mainPipeName(parsed)==L"\\\\.\\pipe\\tahtiapuri-native-mcp-11111111111111111111111111111111","fixed pipe selector");
        rejects([&]{mr::decodeMainBootstrap(bytes.data(),95);});rejects([&]{mr::decodeMainBootstrap(bytes.data(),97);});rejects([&]{mr::decodeMainBootstrap(nullptr,96);});
        for(size_t offset:{0U,7U,8U,12U,20U,23U}){auto bad=bytes;bad[offset]^=0x80;rejects([&]{mr::decodeMainBootstrap(bad.data(),bad.size());});}
        {auto bad=bytes;std::fill(bad.begin()+16,bad.begin()+20,uint8_t{0});rejects([&]{mr::decodeMainBootstrap(bad.data(),bad.size());});}
        {auto bad=bytes;std::fill(bad.begin()+24,bad.begin()+32,uint8_t{0});rejects([&]{mr::decodeMainBootstrap(bad.data(),bad.size());});}
        {
            Fixture f;mr::VerifiedMainPipe peer(f.bootstrap);f.connected();peer.verify();f.empty();
            DWORD flags=0;check(GetHandleInformation(peer.channel(),&flags)&&!(flags&HANDLE_FLAG_INHERIT),"non-inherited channel");
            check(GetHandleInformation(peer.lifetime(),&flags)&&!(flags&HANDLE_FLAG_INHERIT),"non-inherited process");
            uint8_t sent[4]={1,2,3,4},received[4]={};exchange(peer.channel(),sent,4,true);exchange(f.server.value,received,4,false);
            check(std::equal(std::begin(sent),std::end(sent),std::begin(received)),"verified exchange");
        }
        {Fixture f;auto wrong=f.bootstrap;wrong.main.pid=wrong.main.pid==1?2:1;rejectsStage([&]{mr::VerifiedMainPipe peer(wrong);},"main-pipe-wrong-server",ERROR_ACCESS_DENIED);f.empty();}
        {Fixture f;auto stale=f.bootstrap;stale.main.creationTime^=1;rejectsStage([&]{mr::VerifiedMainPipe peer(stale);},"main-identity-mismatch",ERROR_ACCESS_DENIED);f.empty();}
        {mr::MainBootstrap absent;absent.main=mr::queryMainIdentity(GetCurrentProcess());
            check(BCryptGenRandom(nullptr,absent.pipeNonce.data(),16,BCRYPT_USE_SYSTEM_PREFERRED_RNG)>=0,"absent random");rejectsStage([&]{mr::VerifiedMainPipe peer(absent);},"main-pipe-open",ERROR_FILE_NOT_FOUND);}
        std::cout<<"{\"passed\":true,\"groups\":6,\"crossLanguageDescriptor\":true,\"livePipe\":true,\"wrongPidNoBytes\":true,\"staleCreationNoBytes\":true,\"absentPipeRejected\":true}\n";return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
