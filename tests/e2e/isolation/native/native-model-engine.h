#pragma once
#include "transport-wire.h"
#include "native-model-fixture.h"
#include "native-model-pins.h"
#include "llama.h"
#include <bcrypt.h>
#include <atomic>
#include <cstring>
#include <memory>
namespace native_model {
using ::WinError;
inline std::wstring packageDirectory() {
    wchar_t path[2048]={};const DWORD length=GetModuleFileNameW(nullptr,path,2048);
    if(!length||length>=2048) throw WinError("worker-image");
    std::wstring value(path);const auto at=value.find_last_of(L"\\");
    if(at==std::wstring::npos) throw WinError("worker-directory",ERROR_INVALID_DATA);
    return value.substr(0,at);
}
inline std::string utf8(const std::wstring& value) {
    const int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);
    if(size<=0) throw WinError("utf8-size");std::string out(static_cast<size_t>(size),0);
    if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),out.data(),size,nullptr,nullptr)) throw WinError("utf8");
    return out;
}
inline std::string digest(const char* bytes,size_t size) {
    if(size>32768) throw WinError("template-size",ERROR_INVALID_DATA);
    BCRYPT_ALG_HANDLE algorithm=nullptr;BYTE value[32]={};
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0) throw WinError("sha-provider");
    const auto status=BCryptHash(algorithm,nullptr,0,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes)),static_cast<ULONG>(size),value,32);
    BCryptCloseAlgorithmProvider(algorithm,0);if(status<0) throw WinError("sha");
    std::string out;for(BYTE b:value){out+="0123456789abcdef"[b>>4];out+="0123456789abcdef"[b&15];}return out;
}
template<class Fn> Fn symbol(HMODULE module,const char* name) {
    const FARPROC raw=GetProcAddress(module,name);if(!raw) throw WinError("engine-symbol");
    Fn result=nullptr;static_assert(sizeof(result)==sizeof(raw));std::memcpy(&result,&raw,sizeof(raw));return result;
}
#define LLAMA_FUNCTIONS(X) \
 X(llama_backend_init) X(llama_backend_free) X(llama_log_set) \
 X(llama_model_default_params) X(llama_context_default_params) X(llama_model_load_from_file) X(llama_model_free) \
 X(llama_init_from_model) X(llama_free) X(llama_model_get_vocab) X(llama_model_chat_template) \
 X(llama_n_ctx) X(llama_n_batch) X(llama_n_ubatch) X(llama_n_threads) X(llama_n_threads_batch) \
 X(llama_tokenize) X(llama_token_to_piece) X(llama_vocab_is_eog) X(llama_batch_get_one) X(llama_decode) \
 X(llama_sampler_init_greedy) X(llama_sampler_sample) X(llama_sampler_free)
#define GGML_FUNCTIONS(X) X(ggml_backend_register) X(ggml_backend_reg_count) X(ggml_backend_dev_count) X(ggml_backend_dev_get)
struct Api {
#define DECLARE(name) decltype(&::name) name=nullptr;
    LLAMA_FUNCTIONS(DECLARE) GGML_FUNCTIONS(DECLARE)
    DECLARE(ggml_backend_dev_type)
#undef DECLARE
    // Libraries deliberately live until worker exit; no plugin directory scan.
    Api() {
        if(!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)) throw WinError("dll-search");
        const auto folder=packageDirectory();HMODULE ggml=nullptr,llama=nullptr,base=nullptr,cpu=nullptr;
        for(const auto& identity:runtimePins) {
            const std::wstring name=identity.name;const auto path=folder+L"\\"+name;
            const HMODULE h=LoadLibraryExW(path.c_str(),nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
            if(!h){const DWORD error=GetLastError();throw WinError(("engine-library-"+ascii(name)).c_str(),error);}
            wchar_t actual[2048]={};const DWORD length=GetModuleFileNameW(h,actual,2048);
            if(!length||length>=2048||_wcsicmp(actual,path.c_str())!=0)throw WinError("library-origin",ERROR_ACCESS_DENIED);
            if(name==L"ggml.dll")ggml=h;
            if(name==L"llama.dll")llama=h;
            if(name==L"ggml-base.dll")base=h;
            if(name==backendName)cpu=h;
        }
#define LOAD_LLAMA(name) name=symbol<decltype(name)>(llama,#name);
        LLAMA_FUNCTIONS(LOAD_LLAMA)
#undef LOAD_LLAMA
#define LOAD_GGML(name) name=symbol<decltype(name)>(ggml,#name);
        GGML_FUNCTIONS(LOAD_GGML)
#undef LOAD_GGML
        llama_log_set([](enum ggml_log_level,const char*,void*){},nullptr);
        ggml_backend_dev_type=symbol<decltype(ggml_backend_dev_type)>(base,"ggml_backend_dev_type");
        const auto init=symbol<ggml_backend_reg_t(*)()>(cpu,"ggml_backend_init");
        const auto reg=init();if(!reg)throw WinError("cpu-init",ERROR_INVALID_DATA);
        ggml_backend_register(reg);
        if(ggml_backend_reg_count()!=1||ggml_backend_dev_count()!=1||
            ggml_backend_dev_type(ggml_backend_dev_get(0))!=GGML_BACKEND_DEVICE_TYPE_CPU)
            throw WinError("cpu-backend",ERROR_INVALID_DATA);
        llama_backend_init();
    }
};
#undef LLAMA_FUNCTIONS
#undef GGML_FUNCTIONS
struct Outcome {uint32_t input=0,output=0,reason=0,abortObserved=0;std::string text;};
class Engine {
    std::unique_ptr<Api> api;
    llama_model* model=nullptr;llama_context* context=nullptr;llama_sampler* sampler=nullptr;
public:
    ~Engine(){dispose();}
    void dispose() {
        if(!api)return;
        if(sampler){api->llama_sampler_free(sampler);sampler=nullptr;}
        if(context){api->llama_free(context);context=nullptr;}
        if(model){api->llama_model_free(model);model=nullptr;}
        api->llama_backend_free();api.reset();
    }
    void load(std::atomic<bool>& cancel) {
        if(api) throw WinError("duplicate-load",ERROR_INVALID_DATA);
        api=std::make_unique<Api>();
        auto p=api->llama_model_default_params();
        ggml_backend_dev_t devices[]={api->ggml_backend_dev_get(0),nullptr};
        p.devices=devices;p.n_gpu_layers=0;p.split_mode=LLAMA_SPLIT_MODE_NONE;
        p.load_mode=LLAMA_LOAD_MODE_MMAP;p.lazy_mode=LLAMA_LAZY_MODE_OFF;
        p.vocab_only=false;p.no_alloc=false;p.use_extra_bufts=false;p.check_tensors=false;p.load_mtp=false;
        p.progress_callback=[](float,void* user){return !static_cast<std::atomic<bool>*>(user)->load();};
        p.progress_callback_user_data=&cancel;
        const auto file=utf8(packageDirectory()+L"\\model.gguf");
        model=api->llama_model_load_from_file(file.c_str(),p);
        if(!model) throw WinError(cancel.load()?"load-cancelled":"model-load",ERROR_INVALID_DATA);
        const char* tmpl=api->llama_model_chat_template(model,nullptr);
        if(!tmpl||digest(tmpl,strnlen(tmpl,32769))!=templateHash) throw WinError("template-identity",ERROR_INVALID_DATA);
        auto c=api->llama_context_default_params();
        c.n_ctx=512;c.n_batch=32;c.n_ubatch=32;c.n_seq_max=1;c.n_threads=1;c.n_threads_batch=1;
        c.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_DISABLED;c.offload_kqv=false;c.op_offload=false;
        c.abort_callback=[](void* user){return static_cast<std::atomic<bool>*>(user)->load();};c.abort_callback_data=&cancel;
        context=api->llama_init_from_model(model,c);
        if(!context) throw WinError("model-context",ERROR_INVALID_DATA);
        if(api->llama_n_ctx(context)!=512||api->llama_n_batch(context)!=32||api->llama_n_ubatch(context)!=32||
            api->llama_n_threads(context)!=1||api->llama_n_threads_batch(context)!=1) throw WinError("context-readback",ERROR_INVALID_DATA);
        sampler=api->llama_sampler_init_greedy();if(!sampler) throw WinError("sampler");
    }
    Outcome generate(std::atomic<bool>& cancel,const std::function<void()>& computing) {
        if(!context) throw WinError("not-loaded",ERROR_INVALID_DATA);
        const auto vocab=api->llama_model_get_vocab(model);std::vector<llama_token> tokens(256);
        const int count=api->llama_tokenize(vocab,prompt,static_cast<int>(sizeof(prompt)-1),tokens.data(),256,true,true);
        if(count<=0||count>240) throw WinError("prompt-tokens",ERROR_INVALID_DATA);
        Outcome result;result.input=static_cast<uint32_t>(count);
        for(int offset=0;offset<count;) {
            if(cancel.load()){result.reason=2;return result;}
            const int take=std::min(32,count-offset);
            if(offset==0) computing();
            const int code=api->llama_decode(context,api->llama_batch_get_one(tokens.data()+offset,take));
            if(code==2&&cancel.load()){result.reason=2;result.abortObserved=1;return result;}
            if(code!=0) throw WinError("prefill-decode",ERROR_INVALID_DATA);
            offset+=take;
        }
        for(uint32_t i=0;i<16;++i) {
            if(cancel.load()){result.reason=2;return result;}
            const llama_token token=api->llama_sampler_sample(sampler,context,-1);
            if(api->llama_vocab_is_eog(vocab,token)){result.reason=0;return result;}
            char piece[256]={};const int size=api->llama_token_to_piece(vocab,token,piece,256,0,false);
            if(size<0||size>256||result.text.size()+static_cast<size_t>(size)>4096) throw WinError("token-piece",ERROR_INVALID_DATA);
            result.text.append(piece,size);++result.output;
            llama_token next=token;const int code=api->llama_decode(context,api->llama_batch_get_one(&next,1));
            if(code==2&&cancel.load()){result.reason=2;result.abortObserved=1;return result;}
            if(code!=0) throw WinError("token-decode",ERROR_INVALID_DATA);
        }
        result.reason=1;return result;
    }
};
}
