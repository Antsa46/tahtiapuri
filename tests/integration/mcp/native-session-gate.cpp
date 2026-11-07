// Test-only owner actor. Not packaged, not an OS inspector: no worker,
// AppContainer profile, Job, model, network or worker-token inspection is performed.
#include "../../../apps/mcp/native/broker-release.h"
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
enum class RecordFault { None,Write,ShortWrite,Flush,Read,ShortRead,Readback };
bool releaseHold(const std::wstring& mode,size_t& frontier){
    const std::wstring prefix=L"--release-hold-";
    if(mode.compare(0,prefix.size(),prefix)!=0)return false;
    const auto digits=mode.substr(prefix.size());
    if(digits.empty()||digits.size()>2||(digits.size()>1&&digits[0]==L'0'))return false;
    frontier=0;for(wchar_t digit:digits){if(digit<L'0'||digit>L'9')return false;frontier=frontier*10+static_cast<size_t>(digit-L'0');}
    return frontier<=brokerReleaseTargets;
}
bool releaseFault(const std::wstring& mode,bool& completion,RecordFault& fault){
    for(bool candidate:{false,true}){
        const std::wstring prefix=candidate?L"--release-completion-":L"--release-intent-";
        if(mode.compare(0,prefix.size(),prefix)!=0)continue;
        const auto kind=mode.substr(prefix.size());completion=candidate;
        if(kind==L"write")fault=RecordFault::Write;else if(kind==L"short-write")fault=RecordFault::ShortWrite;
        else if(kind==L"flush")fault=RecordFault::Flush;else if(kind==L"read")fault=RecordFault::Read;
        else if(kind==L"short-read")fault=RecordFault::ShortRead;else if(kind==L"readback")fault=RecordFault::Readback;
        else return false;
        return true;
    }
    return false;
}
// This test dependency uses the actual owned record handle. The production
// CLI cannot select it. It returns faults/counts through the same I/O interface.
class FaultRecordIo final:public NativeReleaseRecordIo {
    RecordFault fault;mutable bool used=false;
    bool take(RecordFault selected)const{if(!used&&fault==selected){used=true;return true;}return false;}
public:
    explicit FaultRecordIo(RecordFault selected):fault(selected){}
    bool seek(HANDLE file)const override{return windowsReleaseRecordIo().seek(file);}
    bool write(HANDLE file,const JournalBytes& bytes,DWORD& count)const override{
        if(take(RecordFault::Write)){count=0;SetLastError(ERROR_WRITE_FAULT);return false;}
        if(take(RecordFault::ShortWrite))return WriteFile(file,bytes.data(),16,&count,nullptr)!=FALSE;
        return windowsReleaseRecordIo().write(file,bytes,count);
    }
    bool truncate(HANDLE file)const override{return windowsReleaseRecordIo().truncate(file);}
    bool flush(HANDLE file)const override{
        if(take(RecordFault::Flush)){SetLastError(ERROR_WRITE_FAULT);return false;}
        return windowsReleaseRecordIo().flush(file);
    }
    bool read(HANDLE file,JournalBytes& bytes,DWORD& count)const override{
        if(take(RecordFault::Read)){count=0;SetLastError(ERROR_READ_FAULT);return false;}
        const bool success=windowsReleaseRecordIo().read(file,bytes,count);
        if(success&&take(RecordFault::ShortRead)){if(count)--count;}
        if(success&&take(RecordFault::Readback))bytes[0]^=1;
        return success;
    }
};
}
int wmain(int argc,wchar_t** argv){
    using namespace mcp_runtime;
    if(argc!=3)return 64;
    const std::wstring mode=argv[1];
    size_t frontier=0;bool completionFault=false;RecordFault fault=RecordFault::None;
    const bool heldRelease=releaseHold(mode,frontier),faultRelease=releaseFault(mode,completionFault,fault);
    const bool heldReader=mode==L"--hold-reader"||mode==L"--hold-metadata"||mode==L"--hold-deny-delete",admitAfterRead=mode==L"--admit-after-read";
    const bool normalRelease=mode==L"--release-pristine";
    if(mode!=L"--prepare"&&mode!=L"--seal"&&mode!=L"--publish"&&mode!=L"--publish-hold"&&mode!=L"--admit-hold"
       &&mode!=L"--protect-session"&&mode!=L"--protect-intent"&&mode!=L"--protect-target"&&!heldRelease&&!faultRelease&&!heldReader&&!admitAfterRead&&!normalRelease)return 64;
    const bool hold=mode==L"--publish-hold"||mode==L"--admit-hold"||heldRelease||heldReader||admitAfterRead;
    const auto deadline=clockNow()+(hold?20000:5000);
    BrokerWatchdog watchdog;watchdog.deadline.store(deadline);
    try{
        for(DWORD type:{STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE})
            if(GetFileType(GetStdHandle(type))!=FILE_TYPE_PIPE)throw WinError("session-probe-pipe",ERROR_INVALID_HANDLE);
        if(mode==L"--admit-hold"||admitAfterRead){
            auto bootstrap=readMainBootstrapFile(argv[2]);TicketGuard secret{bootstrap};
            BootstrapDirectoryGuard control(argv[2]);
            if(admitAfterRead){emit("descriptor-read");gate();}
            emit("admission-starting");
            BrokerSessionAdmission admission(control,bootstrap,deadline);
            SecureZeroMemory(bootstrap.launchToken.data(),bootstrap.launchToken.size());
            emit("admitted");if(!admitAfterRead)gate();admission.close();emit("admission-complete");return 0;
        }
        if(heldReader){
            BootstrapDirectoryGuard control(argv[2]);
            const auto path=control.root+L"\\native-session-reserved\\worker\\package\\licenses\\mcp-core-LICENSE.txt";
            BootstrapPin file(path,false,READ_CONTROL|FILE_READ_ATTRIBUTES|(mode==L"--hold-metadata"?0:GENERIC_READ),OPEN_EXISTING,
                FILE_SHARE_READ|FILE_SHARE_WRITE|(mode==L"--hold-deny-delete"?0:FILE_SHARE_DELETE));
            resourceAcl(file,control.owner,nullptr,0,false,false,true);
            emit("reader-held");gate();closeBootstrapHandle(file);emit("reader-complete");return 0;
        }
        if(mode==L"--protect-session"||mode==L"--protect-intent"||mode==L"--protect-target"){
            eof();BootstrapDirectoryGuard control(argv[2]);
            const std::wstring leaf=mode==L"--protect-session"?sessionRecordLeaf:mode==L"--protect-intent"?sessionReleaseLeaf:
                L"native-session-reserved\\worker\\package\\licenses\\mcp-core-LICENSE.txt";
            BootstrapPin file(control.root+L"\\"+leaf,false,READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES);
            requireBootstrapAcl(file.handle.value,control.owner,false);
            // More restrictive fixture ACL, still only owner/SYSTEM. The native
            // session policy must reject its wrong inheritance/protection.
            resourceAcl(file,control.owner,nullptr,0,false,true);
            closeBootstrapHandle(file);emit("session-protected");return 0;
        }
        Input input;input.prefix();
        auto bootstrap=decodeMainBootstrap(input.bytes.data(),input.bytes.size());TicketGuard secret{bootstrap};
        if(!heldRelease&&mode!=L"--publish-hold")eof();
        if(normalRelease||heldRelease||faultRelease){
            FaultRecordIo failing(fault);const auto& real=windowsReleaseRecordIo();
            const std::function<void(size_t)> boundary=heldRelease?std::function<void(size_t)>([&](size_t at){
                if(at==frontier){emit("release-held");gate();}
            }):std::function<void(size_t)>();
            releasePristineBrokerSession(argv[2],bootstrap,deadline,boundary,
                faultRelease&&!completionFault?static_cast<const NativeReleaseRecordIo&>(failing):real,
                faultRelease&&completionFault?static_cast<const NativeReleaseRecordIo&>(failing):real);
            emit("session-released");return 0;
        }
        if(mode==L"--prepare")prepareBrokerSession(argv[2],bootstrap);
        else if(mode==L"--seal")sealBrokerSession(argv[2],bootstrap);
        else if(mode==L"--publish")publishBrokerSession(argv[2],input.bytes);
        else publishBrokerSession(argv[2],input.bytes,[]{emit("published-held");gate();});
        emit(mode==L"--prepare"?"session-prepared":mode==L"--seal"?"session-sealed":"publisher-complete");return 0;
    }catch(const WinError& e){fprintf(stderr,"{\"stage\":\"%s\",\"code\":%lu}\n",e.what(),e.code);return 1;}
    catch(const JournalError& e){fprintf(stderr,"{\"stage\":\"%s\",\"code\":%lu}\n",e.what(),DWORD(ERROR_INVALID_DATA));return 1;}
    catch(...){fputs("{\"stage\":\"session-probe-internal\",\"code\":13}\n",stderr);return 1;}
}
