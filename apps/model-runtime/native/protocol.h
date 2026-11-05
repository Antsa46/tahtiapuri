#pragma once
#include "../../../packages/windows-runtime/native/transport-wire.h"
namespace native_model {
using namespace transport;
constexpr Op load=static_cast<Op>(11),loaded=static_cast<Op>(136),computing=static_cast<Op>(137),failed=static_cast<Op>(138);
constexpr uint32_t contextSize=4096,batchSize=32,inputTokens=3072,outputTokens=512;
constexpr size_t inputBytes=8000,outputBytes=8192;
constexpr char templateHash[]="57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361";
constexpr wchar_t backendName[]=L"ggml-cpu.dll";
inline std::vector<BYTE> words(std::initializer_list<uint32_t> values) {
    std::vector<BYTE> body(values.size()*4);size_t offset=0;
    for(uint32_t value:values){put32(body.data()+offset,value);offset+=4;}return body;
}
inline bool available(HANDLE input) {
    DWORD bytes=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&bytes,nullptr))throw WinError("channel-eof",ERROR_INVALID_DATA);
    return bytes!=0;
}
inline int utf16Length(const std::string& text,size_t maximum) {
    if(text.empty()||text.size()>maximum||text.find('\0')!=std::string::npos)throw WinError("input-invalid",ERROR_INVALID_DATA);
    const int size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);
    if(size<=0)throw WinError("input-invalid",ERROR_INVALID_DATA);return size;
}
inline void validateInput(const std::string& text) {
    if(utf16Length(text,inputBytes)>2000)throw WinError("input-invalid",ERROR_INVALID_DATA);
}
inline void validateOutput(const std::string& text) {
    if(text.empty())return;
    try{utf16Length(text,outputBytes);}
    catch(const WinError&){throw WinError("output-invalid",ERROR_INVALID_DATA);}
}
// Public keys only: never serialize native exception text, paths or DLL names.
inline const char* failureStage(const WinError& error,bool loading,bool cancelled) {
    if(cancelled)return "cancelled";
    const std::string stage=error.what();
    if(stage=="template-identity")return "template-identity";
    if(stage=="model-context"||stage=="context-readback")return "model-context";
    if(stage=="model-load")return "model-load";
    if(stage=="input-invalid"||stage=="input-tokens")return stage=="input-invalid"?"input-invalid":"input-tokens";
    return loading?"runtime-load":"generation-failed";
}
}
