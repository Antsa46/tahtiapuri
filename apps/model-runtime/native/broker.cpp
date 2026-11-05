#include "../../../packages/windows-runtime/native/isolated-launcher.h"
#include "../../../packages/windows-runtime/native/owner-input.h"
#include "protocol.h"
#include "runtime-pins.h"
using namespace isolation;
namespace {
const std::vector<std::wstring> runtimeFiles=[] {std::vector<std::wstring> names;for(const auto& entry:native_model::runtimePins)names.push_back(entry.name);return names;}();
OwnerInput* currentOwner=nullptr;
DWORD launchBudget=175000;
constexpr char modelHash[]="7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5";
void preparing() {
    if(currentOwner&&currentOwner->closingRequested())throw WinError("cancelled",ERROR_OPERATION_ABORTED);
}
std::string hashPinned(HANDLE file) {
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;BYTE value[32]={};
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("sha-provider");
    try {
        if(BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)<0)throw WinError("sha-create");
        std::vector<BYTE> buffer(1024*1024);ULONGLONG bytes=0;const auto deadline=GetTickCount64()+90000;
        for(;;) {
            preparing();
            DWORD count=0;if(!ReadFile(file,buffer.data(),static_cast<DWORD>(buffer.size()),&count,nullptr))throw WinError("sha-read");
            if(!count)break;bytes+=count;
            if(bytes>2497280256ULL||GetTickCount64()>deadline)throw WinError("sha-budget",ERROR_TIMEOUT);
            if(BCryptHashData(hash,buffer.data(),count,0)<0)throw WinError("sha-data");
        }
        if(BCryptFinishHash(hash,value,32,0)<0)throw WinError("sha-finish");
    } catch(...) {if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);throw;}
    BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);
    std::string result;for(BYTE b:value){result+="0123456789abcdef"[b>>4];result+="0123456789abcdef"[b&15];}return result;
}
void prepare(const std::wstring& root,PSID sid,const std::wstring&,Pins& pins) {
    std::vector<std::wstring> entries={L"owner.marker",L"package",L"launcher",L"private",L"scratch"};
    if(sid) entries.push_back(L"profile.receipt");exactEntries(root,entries);
    auto files=runtimeFiles;files.push_back(L"model-worker.exe");files.push_back(L"model.gguf");
    for(const auto& directory:{L"package",L"launcher",L"private",L"scratch"})regular(root+L"\\"+directory,true);
    exactEntries(root+L"\\package",files);exactEntries(root+L"\\launcher",{L"model-broker.exe"});
    exactEntries(root+L"\\private",{L"secret.txt"});exactEntries(root+L"\\scratch",{});
    regular(root+L"\\launcher\\model-broker.exe",false);regular(root+L"\\private\\secret.txt",false);
    for(const auto& file:files)regular(root+L"\\package\\"+file,false);
    setOwnedAcl(root+L"\\launcher",nullptr,0,true);setOwnedAcl(root+L"\\launcher\\model-broker.exe",nullptr,0,false);
    setOwnedAcl(root+L"\\owner.marker",nullptr,0,false);if(sid)setOwnedAcl(root+L"\\profile.receipt",nullptr,0,false);
    setOwnedAcl(root+L"\\private",nullptr,0,true);setOwnedAcl(root+L"\\private\\secret.txt",nullptr,0,false);
    setOwnedAcl(root+L"\\scratch",sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE,true);lowScratch(root+L"\\scratch");
    setOwnedAcl(root+L"\\package",sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    for(const auto& file:files) {
        preparing();
        const auto path=root+L"\\package\\"+file;const bool data=file==L"model.gguf";
        setOwnedAcl(path,sid,FILE_GENERIC_READ|(data?0:FILE_GENERIC_EXECUTE),false);
        HANDLE pin=pins.add(path);
        for(const auto& identity:native_model::runtimePins)
            if(file==identity.name&&hashPinned(pin)!=identity.hash)throw WinError("runtime-pin-hash",ERROR_INVALID_DATA);
        if(file==L"model.gguf") {
            if(hashPinned(pin)!=modelHash)throw WinError("model-pin-hash",ERROR_INVALID_DATA);
            BY_HANDLE_FILE_INFORMATION info={};
            if(!GetFileInformationByHandle(pin,&info)||info.nNumberOfLinks!=1||
                ((ULONGLONG(info.nFileSizeHigh)<<32)|info.nFileSizeLow)!=2497280256ULL)throw WinError("model-pin-size",ERROR_INVALID_DATA);
            for(DWORD access:{DWORD(GENERIC_WRITE),DWORD(DELETE)}) {
                Handle attempt(CreateFileW(path.c_str(),access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr));
                if(attempt.value!=INVALID_HANDLE_VALUE||GetLastError()!=ERROR_SHARING_VIOLATION)throw WinError("model-pin-sharing",ERROR_INVALID_DATA);
            }
        }
    }
    setOwnedAcl(root,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
}
void relay(const std::wstring&,Channel& channel,HANDLE child,Handle&,HANDLE,Watchdog& watchdog) {
    bool hello=false,loading=false,generating=false;uint32_t shutdown=0;
    for(;;) {
        watchdog.checkOwner(&currentOwner->lost);
        Frame request{};
        while(currentOwner->take(request)) {
            if(request.op==Op::hello) {
                if(hello||loading||shutdown)throw WinError("owner-order",ERROR_INVALID_DATA);
                hello=true;
            } else if(request.op==native_model::load) {
                if(!hello||loading||shutdown)throw WinError("owner-order",ERROR_INVALID_DATA);
                loading=true;
            } else if(request.op==Op::begin) {
                if(!loading||generating||shutdown)throw WinError("owner-order",ERROR_INVALID_DATA);
                generating=true;
            } else if(request.op==Op::shutdown) {
                if(shutdown)throw WinError("owner-order",ERROR_INVALID_DATA);
                shutdown=request.id;
            } else throw WinError("owner-operation",ERROR_INVALID_DATA);
            channel.request(request.op,request.id,request.body);
        }
        if(!native_model::available(channel.input)){Sleep(2);continue;}
        const auto response=channel.read();
        const auto op=static_cast<uint16_t>(response.op);
        if(response.body.size()>native_model::outputBytes+16||
            !(op==129||op==131||op==134||op==135||op==136||op==137||op==138))throw WinError("worker-response",ERROR_INVALID_DATA);
        std::string body;
        body.reserve(response.body.size()*2);
        for(BYTE b:response.body){body+="0123456789abcdef"[b>>4];body+="0123456789abcdef"[b&15];}
        emit("{\"type\":\"frame\",\"op\":"+std::to_string(op)+",\"id\":"+std::to_string(response.id)+",\"bodyHex\":\""+body+"\"}");
        if(response.op==Op::bye) {
            if(!shutdown||response.id!=shutdown||!expectedExit(child,0))throw WinError("worker-close",ERROR_INVALID_DATA);
            DWORD remaining=0;
            if(PeekNamedPipe(channel.input,nullptr,0,nullptr,&remaining,nullptr)) {
                if(remaining)throw WinError("worker-tail",ERROR_INVALID_DATA);
            } else if(GetLastError()!=ERROR_BROKEN_PIPE)throw WinError("worker-tail");
            return;
        }
    }
}
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(!SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS)||!SetProcessAffinityMask(GetCurrentProcess(),1))
            throw WinError("broker-limits");
        DWORD_PTR affinity=0,system=0;
        if(GetPriorityClass(GetCurrentProcess())!=BELOW_NORMAL_PRIORITY_CLASS||
            !GetProcessAffinityMask(GetCurrentProcess(),&affinity,&system)||affinity!=1)throw WinError("broker-limit-readback",ERROR_INVALID_DATA);
        std::unique_ptr<OwnerInput> owner;
        const bool run=argc==8&&std::wstring(argv[1])==L"run";
        const bool observe=argc==5&&std::wstring(argv[1])==L"observe";
        const bool cleanup=argc==4&&std::wstring(argv[1])==L"cleanup";
        if(run) {
            // The production entrypoint has a single CPU policy. A backend,
            // model or MCP request cannot select an ordinary/control fallback.
            if(std::wstring(argv[2])!=L"lpac"||std::wstring(argv[5])!=L"desktop")throw WinError("arguments",ERROR_INVALID_PARAMETER);
            launchBudget=boundedNumber(argv[7],175000);
            if(launchBudget<1000)throw WinError("budget",ERROR_INVALID_PARAMETER);
            owner=std::make_unique<OwnerInput>(GetStdHandle(STD_INPUT_HANDLE),parseSession(argv[6]));currentOwner=owner.get();
        } else if(!observe&&!cleanup)throw WinError("arguments",ERROR_INVALID_PARAMETER);
        const LaunchSpec spec{L"tahtiapuri.model.","TAHTIAPURI_NATIVE_CPU_V1",L"model-worker.exe",SIZE_T(6)*1024*1024*1024,
            {L"desktop"},[](const std::wstring&)->DWORD{return launchBudget;},prepare,relay,owner?&owner->lost:nullptr};
        return isolation::run(run?6:argc,argv,spec);
    } catch(...) {return 64;}
}
