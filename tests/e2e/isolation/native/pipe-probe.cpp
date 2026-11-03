#include "common.h"

// A bounded Win32 namespace diagnostic, not a libuv/Node/SDK execution.
static void transfer(HANDLE pipe, bool writing, char* bytes, DWORD count) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.value) throw WinError("pipe-event");
    OVERLAPPED operation = {}; operation.hEvent = event.value;
    DWORD done = 0;
    const BOOL immediate = writing ? WriteFile(pipe, bytes, count, &done, &operation)
                                  : ReadFile(pipe, bytes, count, &done, &operation);
    if (!immediate) {
        const DWORD error = GetLastError();
        if (error != ERROR_IO_PENDING) throw WinError("pipe-transfer", error);
        if (WaitForSingleObject(event.value, 2000) != WAIT_OBJECT_0) {
            CancelIoEx(pipe, &operation);
            GetOverlappedResult(pipe, &operation, &done, TRUE);
            throw WinError("pipe-transfer-deadline", WAIT_TIMEOUT);
        }
        if (!GetOverlappedResult(pipe, &operation, &done, FALSE)) throw WinError("pipe-result");
    }
    if (done != count) throw WinError("pipe-transfer-length", ERROR_INVALID_DATA);
}
static void trial(bool local) {
    LARGE_INTEGER counter = {}; QueryPerformanceCounter(&counter);
    const std::wstring name = std::wstring(L"\\\\.\\pipe\\") + (local ? L"LOCAL\\" : L"")
        + L"tahtiapuri-t09c-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(counter.QuadPart);
    DWORD error = 0; std::string stage = "complete";
    {
        // Each name is attempted exactly once. Remote clients are rejected.
        Handle server(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr));
        if (server.value == INVALID_HANDLE_VALUE) { error = GetLastError(); stage = "create"; }
        else {
            Handle client(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
            if (client.value == INVALID_HANDLE_VALUE) { error = GetLastError(); stage = "open"; }
            else {
                try {
                    // Opening the client connects it before this call.
                    OVERLAPPED connection = {};
                    Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr));
                    if (!connected.value) throw WinError("pipe-connect-event");
                    connection.hEvent = connected.value;
                    if (!ConnectNamedPipe(server.value, &connection)) {
                        const DWORD connectError = GetLastError();
                        if (connectError == ERROR_IO_PENDING) {
                            CancelIoEx(server.value, &connection); DWORD ignored = 0;
                            GetOverlappedResult(server.value, &connection, &ignored, TRUE);
                            throw WinError("pipe-connect-order", ERROR_INVALID_DATA);
                        }
                        if (connectError != ERROR_PIPE_CONNECTED) throw WinError("pipe-connect", connectError);
                    }
                    char ping[] = "PING", pong[] = "PONG", received[4] = {};
                    transfer(client.value, true, ping, 4); transfer(server.value, false, received, 4);
                    if (std::string(received, 4) != "PING") throw WinError("pipe-ping", ERROR_INVALID_DATA);
                    transfer(server.value, true, pong, 4); transfer(client.value, false, received, 4);
                    if (std::string(received, 4) != "PONG") throw WinError("pipe-pong", ERROR_INVALID_DATA);
                } catch (const WinError& failure) { error = failure.code; stage = failure.what(); }
            }
        }
    } // Both endpoints are closed before the result is emitted.
    emit("{\"type\":\"pipe-result\",\"namespace\":\"" + std::string(local ? "local" : "ordinary")
        + "\",\"attempts\":1,\"stage\":\"" + stage + "\",\"code\":" + std::to_string(error)
        + ",\"roundTrip\":" + (error == 0 ? "true" : "false") + "}");
}
static DWORD WINAPI watchdog(void* event) {
    if (WaitForSingleObject(static_cast<HANDLE>(event), 15000) != WAIT_OBJECT_0)
        TerminateProcess(GetCurrentProcess(), 78);
    return 0;
}
struct Watchdog {
    Handle finished, timer;
    Watchdog() {
        finished.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!finished.value) throw WinError("pipe-watchdog-event");
        timer.value = CreateThread(nullptr, 0, watchdog, finished.value, 0, nullptr);
        if (!timer.value) throw WinError("pipe-watchdog-thread");
    }
    ~Watchdog() {
        // Closing a thread handle does not stop its wait on the event.
        if (!SetEvent(finished.value) || WaitForSingleObject(timer.value, 1000) != WAIT_OBJECT_0) {
            TerminateProcess(GetCurrentProcess(), 79);
            ExitProcess(79);
        }
    }
};
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 10 || std::wstring(argv[7]) != L"once" || std::wstring(argv[9]) != L"primary")
            throw WinError("pipe-arguments", ERROR_INVALID_PARAMETER);
        Watchdog timer;
        trial(false); trial(true);
        return 0;
    } catch (const WinError& error) {
        try { emit("{\"type\":\"probe-error\",\"stage\":\"" + std::string(error.what()) + "\",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {}
    }
    return 1;
}
