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
template<size_t Size>
std::array<uint8_t,Size> input() {
    // Read at most expected+1 bytes. The extra byte rejects trailing input;
    // complete expected bytes still require EOF within the original watchdog.
    std::array<uint8_t,Size+1> bytes={};size_t used=0;
    for(;;) {
        DWORD count=0;
        const BOOL ok=ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes.data()+used,static_cast<DWORD>(bytes.size()-used),&count,nullptr);
        if(!ok) { if(GetLastError()==ERROR_BROKEN_PIPE)break;throw WinError("bootstrap-stdin"); }
        if(!count)break;
        used+=count;
        if(used==bytes.size())throw WinError("bootstrap-input-size",ERROR_INVALID_DATA);
    }
    if(used!=Size)throw WinError("bootstrap-input-size",ERROR_INVALID_DATA);
    std::array<uint8_t,Size> result={};
    std::copy_n(bytes.data(),result.size(),result.data());
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
        if(mode==L"--recover") {
            // Empty/broken stdin cannot grant recovery. A complete public frame
            // followed by broken pipe is still a delivered grant, not revocation.
            constexpr std::array<uint8_t,8> expected={'T','H','R','E','C','0','0','1'};
            const auto grant=input<expected.size()>();
            if(grant!=expected)throw WinError("bootstrap-recovery-grant",ERROR_INVALID_DATA);
            mcp_runtime::recoverMainBootstrap(argv[2]);
        } else {
            auto bytes=input<mcp_runtime::bootstrapBytes>();
            if(mode==L"--publish")mcp_runtime::publishMainBootstrap(argv[2],bytes);
            else mcp_runtime::consumeMainBootstrap(argv[2],bytes);
            SecureZeroMemory(bytes.data(),bytes.size());
        }
        emit(mode==L"--publish"?"published":mode==L"--consume"?"consumed":"descriptor-absent");
        return 0;
    } catch(const WinError& error) {
        // Fixed stage/code only; never paths, bytes, identities or capabilities.
        if(deadline)fprintf(stderr,"%s:%lu\n",error.what(),error.code);return 1;
    } catch(...) { if(deadline)fputs("bootstrap-invalid\n",stderr);return 1; }
}
