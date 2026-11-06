#include "bootstrap-publication.h"
#include <thread>
#include <cstdio>

namespace {
class Deadline {
    Handle stopped_{CreateEventW(nullptr,TRUE,FALSE,nullptr)};
    std::thread thread_;
public:
    Deadline() {
        if(!stopped_.value)throw WinError("bootstrap-deadline-event");
        thread_=std::thread([this] {
            // Covers stalled stdin and synchronous filesystem/output operations.
            // Process termination closes handles; ambiguous publication is not
            // converted to success or retried by this helper.
            if(WaitForSingleObject(stopped_.value,5000)!=WAIT_OBJECT_0)
                TerminateProcess(GetCurrentProcess(),70);
        });
    }
    ~Deadline(){SetEvent(stopped_.value);if(thread_.joinable())thread_.join();}
};
std::array<uint8_t,mcp_runtime::bootstrapBytes> input(bool expected) {
    std::array<uint8_t,mcp_runtime::bootstrapBytes+1> bytes={};size_t used=0;
    for(;;) {
        DWORD count=0;
        const BOOL ok=ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes.data()+used,static_cast<DWORD>(bytes.size()-used),&count,nullptr);
        if(!ok) { if(GetLastError()==ERROR_BROKEN_PIPE)break;throw WinError("bootstrap-stdin"); }
        if(!count)break;
        used+=count;
        if(used==bytes.size()||(!expected&&used))throw WinError("bootstrap-input-size",ERROR_INVALID_DATA);
    }
    if(used!=(expected?mcp_runtime::bootstrapBytes:0))throw WinError("bootstrap-input-size",ERROR_INVALID_DATA);
    std::array<uint8_t,mcp_runtime::bootstrapBytes> result={};
    if(expected)std::copy_n(bytes.data(),result.size(),result.data());
    SecureZeroMemory(bytes.data(),bytes.size());return result;
}
}
int wmain(int argc,wchar_t** argv) {
    std::unique_ptr<Deadline> deadline;
    try {
        if(argc!=3)return 64;
        const std::wstring mode=argv[1];
        if(mode!=L"--publish"&&mode!=L"--consume"&&mode!=L"--recover")return 64;
        deadline=std::make_unique<Deadline>();
        auto bytes=input(mode!=L"--recover");
        if(mode==L"--publish")mcp_runtime::publishMainBootstrap(argv[2],bytes);
        else if(mode==L"--consume")mcp_runtime::consumeMainBootstrap(argv[2],bytes);
        else mcp_runtime::recoverMainBootstrap(argv[2]);
        SecureZeroMemory(bytes.data(),bytes.size());
        emit(mode==L"--publish"?"published":mode==L"--consume"?"consumed":"descriptor-absent");
        return 0;
    } catch(const WinError& error) {
        // Fixed stage/code only; never paths, bytes, identities or capabilities.
        if(deadline)fprintf(stderr,"%s:%lu\n",error.what(),error.code);return 1;
    } catch(...) { if(deadline)fputs("bootstrap-invalid\n",stderr);return 1; }
}
