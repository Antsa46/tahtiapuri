#include "isolated-launcher.h"
#include "native-model-protocol.h"
#include "native-model-fixture.h"
#include "native-model-pins.h"
using namespace isolation;
namespace {
const std::vector<std::wstring> runtimeFiles=[] {std::vector<std::wstring> names;for(const auto& entry:native_model::runtimePins)names.push_back(entry.name);return names;}();
const std::vector<std::wstring> cases={L"normal",L"cancel",L"shutdown-pending",L"owner-loss",L"missing-model",L"missing-library"};
std::string hashPinned(HANDLE file) {
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;BYTE value[32]={};
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw WinError("sha-provider");
    try {
        if(BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)<0)throw WinError("sha-create");
        std::vector<BYTE> buffer(1024*1024);ULONGLONG bytes=0;const auto deadline=GetTickCount64()+90000;
        for(;;) {
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
void prepare(const std::wstring& root,PSID sid,const std::wstring& kind,Pins& pins) {
    std::vector<std::wstring> entries={L"owner.marker",L"package",L"launcher",L"private",L"scratch"};
    if(sid) entries.push_back(L"profile.receipt");exactEntries(root,entries);
    auto files=runtimeFiles;
    if(kind==L"missing-library")files.erase(std::find(files.begin(),files.end(),native_model::backendName));
    files.push_back(L"native-model-worker.exe");files.push_back(L"readonly.txt");
    if(kind!=L"missing-model")files.push_back(L"model.gguf");
    for(const auto& directory:{L"package",L"launcher",L"private",L"scratch"})regular(root+L"\\"+directory,true);
    exactEntries(root+L"\\package",files);exactEntries(root+L"\\launcher",{L"native-model-host.exe"});
    exactEntries(root+L"\\private",{L"secret.txt"});exactEntries(root+L"\\scratch",{});
    regular(root+L"\\launcher\\native-model-host.exe",false);regular(root+L"\\private\\secret.txt",false);
    for(const auto& file:files)regular(root+L"\\package\\"+file,false);
    setOwnedAcl(root+L"\\launcher",nullptr,0,true);setOwnedAcl(root+L"\\launcher\\native-model-host.exe",nullptr,0,false);
    setOwnedAcl(root+L"\\owner.marker",nullptr,0,false);if(sid)setOwnedAcl(root+L"\\profile.receipt",nullptr,0,false);
    setOwnedAcl(root+L"\\private",nullptr,0,true);setOwnedAcl(root+L"\\private\\secret.txt",nullptr,0,false);
    setOwnedAcl(root+L"\\scratch",sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE,true);lowScratch(root+L"\\scratch");
    setOwnedAcl(root+L"\\package",sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    for(const auto& file:files) {
        const auto path=root+L"\\package\\"+file;const bool data=file==L"model.gguf"||file==L"readonly.txt";
        setOwnedAcl(path,sid,FILE_GENERIC_READ|(data?0:FILE_GENERIC_EXECUTE),false);
        if(file==L"readonly.txt")continue; // ACL probe must not be denied merely by a sharing lock.
        HANDLE pin=pins.add(path);
        for(const auto& identity:native_model::runtimePins)
            if(file==identity.name&&hashPinned(pin)!=identity.hash)throw WinError("runtime-pin-hash",ERROR_INVALID_DATA);
        if(file==L"model.gguf") {
            if(hashPinned(pin)!=native_model::modelHash)throw WinError("model-pin-hash",ERROR_INVALID_DATA);
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
Frame awaitFrame(Channel& channel,DWORD duration=90000) {
    const auto end=GetTickCount64()+duration;
    while(!native_model::available(channel.input)) {
        if(GetTickCount64()>=end)throw WinError("model-response-deadline",ERROR_TIMEOUT);
        Sleep(2);
    }
    return channel.read(); // An incomplete frame still has the unchanged 2.5 s bound.
}
Frame expect(Channel& channel,Op op,uint32_t id,DWORD duration=90000) {
    auto frame=awaitFrame(channel,duration);
    if(frame.op!=op||frame.id!=id)throw WinError("model-response-contract",ERROR_INVALID_DATA);
    return frame;
}
std::string hex(const std::vector<BYTE>& body,size_t offset) {
    std::string out;
    for(size_t n=offset;n<body.size();++n){out+="0123456789abcdef"[body[n]>>4];out+="0123456789abcdef"[body[n]&15];}return out;
}
void exercise(const std::wstring& kind,Channel& ch,HANDLE child,Handle&,HANDLE,Watchdog& watchdog) {
    emit(std::string("{\"type\":\"model-identity\",\"modelPinned\":")+(kind==L"missing-model"?"false":"true")+
        ",\"modelSha256\":\""+(kind==L"missing-model"?"":native_model::modelHash)+"\",\"runtimePinned\":true}");
    ch.request(Op::hello,1);ch.expect(Op::ready,1);
    ch.request(native_model::load,2);ch.expect(Op::pending,2);
    auto ready=awaitFrame(ch);
    if(kind==L"missing-model"||kind==L"missing-library") {
        const std::string expected=kind==L"missing-model"?"model-load":"engine-library-ggml-cpu.dll";
        if(ready.op!=native_model::failed||ready.id!=2||ready.body.size()<5||std::string(ready.body.begin()+4,ready.body.end())!=expected) {
            if(ready.op==native_model::failed&&ready.body.size()>=4)
                emit("{\"type\":\"model-load-error\",\"code\":"+std::to_string(get32(ready.body.data()))+",\"stageHex\":\""+hex(ready.body,4)+"\"}");
            throw WinError("expected-load-failure",ERROR_INVALID_DATA);
        }
        emit("{\"type\":\"model-expected-failure\",\"stage\":\""+expected+"\"}");
        ch.request(Op::shutdown,3);auto bye=expect(ch,Op::bye,3);
        if(bye.body!=native_model::words({1,0,0})||!expectedExit(child,0))throw WinError("failed-load-shutdown",ERROR_INVALID_DATA);
        return;
    }
    if(ready.op==native_model::failed&&ready.body.size()>=4) {
        emit("{\"type\":\"model-load-error\",\"code\":"+std::to_string(get32(ready.body.data()))+",\"stageHex\":\""+hex(ready.body,4)+"\"}");
        throw WinError("model-load-failed",ERROR_INVALID_DATA);
    }
    auto expected=native_model::words({512,32,32,1,1,0});
    expected.insert(expected.end(),native_model::templateHash,native_model::templateHash+64);
    if(ready.op!=native_model::loaded||ready.id!=2||ready.body.size()!=expected.size()+12||
        !std::equal(expected.begin(),expected.end(),ready.body.begin()))throw WinError("model-loaded-contract",ERROR_INVALID_DATA);
    const auto token=inspectToken(child);
    const DWORD readError=get32(ready.body.data()+expected.size()),writeError=get32(ready.body.data()+expected.size()+4),scratchError=get32(ready.body.data()+expected.size()+8);
    if(readError!=(token.app?5u:0u)||writeError!=(token.app?5u:0u)||scratchError!=0)throw WinError("file-probe-result",ERROR_ACCESS_DENIED);
    emit("{\"type\":\"model-loaded\",\"context\":512,\"batch\":32,\"threads\":1,\"gpuLayers\":0,\"cpuDevices\":1,\"templateVerified\":true,\"privateReadError\":"+
        std::to_string(readError)+",\"readonlyWriteError\":"+std::to_string(writeError)+",\"scratchWriteError\":0}");
    ch.request(Op::begin,3);ch.expect(Op::pending,3);
    auto active=expect(ch,native_model::computing,3);
    if(!active.body.empty())throw WinError("computing-body",ERROR_INVALID_DATA);
    if(kind==L"owner-loss") {
        emit("{\"type\":\"await-owner\",\"pid\":"+std::to_string(GetProcessId(child))+"}");
        while(watchdog.reason.load()==0)Sleep(20);
        if(watchdog.reason.load()!=1||!expectedExit(child,42))throw WinError("owner-loss",ERROR_INVALID_DATA);
        return;
    }
    if(kind==L"shutdown-pending") {
        ch.request(Op::shutdown,4);
        const auto bye=expect(ch,Op::bye,4);
        if(bye.body!=native_model::words({1,1,2})||!expectedExit(child,0))throw WinError("cooperative-shutdown",ERROR_INVALID_DATA);
        emit("{\"type\":\"model-shutdown\",\"disposedAfterJoin\":true,\"decodeAborted\":true}");
        return;
    }
    if(kind==L"cancel"){ch.request(Op::cancel,4,number(3));ch.expect(Op::pending,4);}
    const auto done=expect(ch,Op::done,3);
    if(done.body.size()<16||done.body.size()>4112)throw WinError("model-result-size",ERROR_INVALID_DATA);
    const auto in=get32(done.body.data()),out=get32(done.body.data()+4),reason=get32(done.body.data()+8),aborted=get32(done.body.data()+12);
    if(!in||in>240||out>16||reason>2||aborted>1)throw WinError("model-result-range",ERROR_INVALID_DATA);
    if(kind==L"cancel") {
        if(reason!=2||aborted!=1)throw WinError("cooperative-cancel",ERROR_INVALID_DATA);
        auto cancelled=expect(ch,Op::cancelled,4);
        if(cancelled.body!=number(3))throw WinError("cancelled-job",ERROR_INVALID_DATA);
    } else if(out==0||done.body.size()==16||reason!=0||aborted)throw WinError("empty-or-unfinished-generation",ERROR_INVALID_DATA);
    emit("{\"type\":\"model-output\",\"inputTokens\":"+std::to_string(in)+",\"outputTokens\":"+std::to_string(out)+",\"reason\":"+
        std::to_string(reason)+",\"decodeAborted\":"+(aborted?"true":"false")+",\"textHex\":\""+hex(done.body,16)+"\"}");
    const uint32_t closeId=kind==L"cancel"?5:4;ch.request(Op::shutdown,closeId);
    const auto bye=expect(ch,Op::bye,closeId);
    if(bye.body!=native_model::words({1,aborted,reason})||!expectedExit(child,0))throw WinError("model-shutdown",ERROR_INVALID_DATA);
    emit(std::string("{\"type\":\"model-shutdown\",\"disposedAfterJoin\":true,\"decodeAborted\":")+(aborted?"true":"false")+"}");
}
}
int wmain(int argc,wchar_t** argv) {
    const Experiment spec{L"tahtiapuri.t09i.","TAHTIAPURI_T09I_NATIVE_MODEL",L"native-model-worker.exe",SIZE_T(6)*1024*1024*1024,
        cases,[](const std::wstring&)->DWORD{return 180000;},prepare,exercise};
    return isolation::run(argc,argv,spec);
}
