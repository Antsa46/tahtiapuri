#include "common.h"
#include <cstdint>

struct Socket {
    SOCKET value = INVALID_SOCKET;
    explicit Socket(SOCKET socket) : value(socket) {}
    ~Socket() { if (value != INVALID_SOCKET) closesocket(value); }
    Socket(const Socket&) = delete;
};
struct EmergencyStop {
    HANDLE process;
    ~EmergencyStop() { TerminateProcess(process, 43); WaitForSingleObject(process, 5000); }
};
static std::string phase;
static void report(const char* name, bool ok, DWORD code, bool attempted = true) {
    emit("{\"type\":\"operation\",\"phase\":\"" + phase + "\",\"name\":\"" + name + "\",\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + ",\"attempted\":" + (attempted ? "true" : "false") + "}");
}
static void readFile(const std::wstring& path, const char* name) {
    Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) { report(name, false, GetLastError()); return; }
    char data[64] = {}; DWORD read = 0;
    const bool ok = ReadFile(file.value, data, sizeof(data), &read, nullptr) != FALSE;
    report(name, ok && read > 0, ok ? 0 : GetLastError());
}
static void writeFile(const std::wstring& path, const char* name, bool create) {
    Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, create ? CREATE_ALWAYS : OPEN_EXISTING, 0, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) { report(name, false, GetLastError()); return; }
    DWORD written = 0; const bool ok = WriteFile(file.value, "W", 1, &written, nullptr) != FALSE;
    report(name, ok && written == 1, ok ? 0 : GetLastError());
}
static ULONGLONG utcMilliseconds() {
    FILETIME time = {}; GetSystemTimePreciseAsFileTime(&time);
    ULARGE_INTEGER ticks = {}; ticks.LowPart = time.dwLowDateTime; ticks.HighPart = time.dwHighDateTime;
    return (ticks.QuadPart - 116444736000000000ULL) / 10000;
}
static void network(bool ipv6, bool datagram, unsigned short port, const char* name, bool bindLoopback) {
    const auto startedAt = utcMilliseconds();
    Socket socket(::socket(ipv6 ? AF_INET6 : AF_INET, datagram ? SOCK_DGRAM : SOCK_STREAM, datagram ? IPPROTO_UDP : IPPROTO_TCP));
    const auto finish = [&](bool ok, int code, const char* stage) {
        const auto finishedAt = utcMilliseconds();
        sockaddr_storage local = {}; int length = sizeof(local); unsigned short localPort = 0;
        int endpointError = 0;
        if (socket.value == INVALID_SOCKET) endpointError = WSAENOTSOCK;
        else if (getsockname(socket.value, reinterpret_cast<sockaddr*>(&local), &length) == SOCKET_ERROR) endpointError = WSAGetLastError();
        else if (local.ss_family == AF_INET) localPort = ntohs(reinterpret_cast<sockaddr_in*>(&local)->sin_port);
        else if (local.ss_family == AF_INET6) localPort = ntohs(reinterpret_cast<sockaddr_in6*>(&local)->sin6_port);
        else endpointError = WSAEAFNOSUPPORT;
        char localAddress[INET6_ADDRSTRLEN] = {};
        if (endpointError == 0) {
            const void* raw = local.ss_family == AF_INET ? static_cast<const void*>(&reinterpret_cast<sockaddr_in*>(&local)->sin_addr) : static_cast<const void*>(&reinterpret_cast<sockaddr_in6*>(&local)->sin6_addr);
            if (!InetNtopA(local.ss_family, const_cast<void*>(raw), localAddress, sizeof(localAddress))) endpointError = WSAGetLastError();
        }
        // Diagnostic correlation only: a local deadline is never a WFP deny event.
        emit("{\"type\":\"network-detail\",\"phase\":\"" + phase + "\",\"name\":\"" + name + "\",\"pid\":" + std::to_string(GetCurrentProcessId()) +
             ",\"stage\":\"" + stage + "\",\"protocol\":" + std::to_string(datagram ? IPPROTO_UDP : IPPROTO_TCP) +
             ",\"remoteAddress\":\"" + (ipv6 ? "::1" : "127.0.0.1") + "\",\"remotePort\":" + std::to_string(port) +
             ",\"startedAtMs\":" + std::to_string(startedAt) + ",\"finishedAtMs\":" + std::to_string(finishedAt) + ",\"localAddress\":\"" + localAddress + "\",\"localPort\":" + std::to_string(localPort) + ",\"localEndpointError\":" + std::to_string(endpointError) +
             ",\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + "}");
        report(name, ok, static_cast<DWORD>(code));
    };
    if (socket.value == INVALID_SOCKET) { const int error = WSAGetLastError(); finish(false, error, "socket"); return; }
    const DWORD timeout = 1500;
    if (setsockopt(socket.value, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) == SOCKET_ERROR) throw WinError("socket-timeout", WSAGetLastError());
    if (setsockopt(socket.value, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) == SOCKET_ERROR) throw WinError("socket-timeout", WSAGetLastError());
    sockaddr_in address4 = {}; address4.sin_family = AF_INET; address4.sin_port = htons(port); address4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sockaddr_in6 address6 = {}; address6.sin6_family = AF_INET6; address6.sin6_port = htons(port); address6.sin6_addr = in6addr_loopback;
    const sockaddr* address = ipv6 ? reinterpret_cast<sockaddr*>(&address6) : reinterpret_cast<sockaddr*>(&address4);
    const int length = ipv6 ? sizeof(address6) : sizeof(address4);
    if (bindLoopback) {
        auto local4 = address4; local4.sin_port = 0;
        auto local6 = address6; local6.sin6_port = 0;
        const sockaddr* local = ipv6 ? reinterpret_cast<sockaddr*>(&local6) : reinterpret_cast<sockaddr*>(&local4);
        if (bind(socket.value, local, length) == SOCKET_ERROR) { const int error = WSAGetLastError(); finish(false, error, "bind"); return; }
    }
    // Blocking connect is bounded with a nonblocking select, including on controls.
    u_long nonblocking = 1; if (ioctlsocket(socket.value, FIONBIO, &nonblocking) == SOCKET_ERROR) throw WinError("socket-nonblocking", WSAGetLastError());
    if (connect(socket.value, address, length) == SOCKET_ERROR) {
        int error = WSAGetLastError(); const char* stage = "connect";
        if (error == WSAEWOULDBLOCK) {
            fd_set writable, failed; FD_ZERO(&writable); FD_ZERO(&failed); FD_SET(socket.value, &writable); FD_SET(socket.value, &failed);
            timeval limit = {}; limit.tv_sec = 2;
            const int ready = select(0, nullptr, &writable, &failed, &limit);
            if (ready > 0) { int bytes = sizeof(error); stage = "connect-result"; if (getsockopt(socket.value, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &bytes) == SOCKET_ERROR) { error = WSAGetLastError(); stage = "connect-query"; } }
            else { error = ready == 0 ? WSAETIMEDOUT : WSAGetLastError(); stage = ready == 0 ? "connect-deadline" : "connect-select"; }
        }
        if (error != 0) { finish(false, error, stage); return; }
    }
    nonblocking = 0; if (ioctlsocket(socket.value, FIONBIO, &nonblocking) == SOCKET_ERROR) throw WinError("socket-blocking", WSAGetLastError());
    const int sent = send(socket.value, "T09A", 4, 0);
    if (sent != 4) { const int error = sent == SOCKET_ERROR ? WSAGetLastError() : 0; finish(false, error, "send"); return; }
    char response[4] = {}; const int received = recv(socket.value, response, sizeof(response), 0);
    const int error = received == SOCKET_ERROR ? WSAGetLastError() : 0;
    finish(received == 4 && std::string(response, 4) == "T09A", error, received == SOCKET_ERROR ? "receive" : "echo");
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 10) throw WinError("probe-arguments", ERROR_INVALID_PARAMETER);
        const std::wstring root(argv[1]); std::wstring life(argv[7]); phase = ascii(argv[9]);
        const bool bindLoopback = life == L"network-once" || life == L"network-fail" || life == L"network-hold";
        if (bindLoopback) life = life.substr(8);
        const bool primaryOnly = phase == "primary-only"; if (primaryOnly) phase = "primary";
        if (phase != "primary" && phase != "descendant") throw WinError("probe-phase", ERROR_INVALID_PARAMETER);
        const auto view = inspectToken(GetCurrentProcess()); BOOL inJob = FALSE;
        if (!IsProcessInJob(GetCurrentProcess(), nullptr, &inJob)) throw WinError("self-job");
        emit("{\"type\":\"token\",\"phase\":\"" + phase + "\",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"job\":" + (inJob ? "true" : "false") + ",\"appContainer\":" + (view.app ? "true" : "false") + ",\"lpac\":" + jsonFlag(view.lpac) + ",\"lpacQueryError\":" + std::to_string(view.lpacQueryError) + ",\"lpacQueryBytes\":" + std::to_string(view.lpacQueryBytes) + ",\"capabilities\":" + std::to_string(view.capabilities) + ",\"integrity\":" + std::to_string(view.integrity) + ",\"sid\":\"" + ascii(view.sid) + "\"}");
        boundedNumber(argv[8], MAXDWORD); // Host verifies inheritance before ResumeThread.
        readFile(root + L"\\package\\allowed.txt", "package-read");
        readFile(root + L"\\package\\weights.fixture", "weights-read");
        readFile(root + L"\\package\\legacy.fixture", "aap-read");
        writeFile(root + L"\\scratch\\" + argv[9] + L".txt", "scratch-write", true);
        readFile(root + L"\\private\\secret.txt", "outside-read");
        writeFile(root + L"\\private\\" + argv[9] + L".txt", "outside-write", true);
        writeFile(root + L"\\package\\weights.fixture", "resource-write", false);
        writeFile(root + L"\\package\\module.mjs", "code-write", false);
        WSADATA data = {}; const int startup = WSAStartup(MAKEWORD(2, 2), &data);
        if (startup != 0) {
            emit("{\"type\":\"network-startup\",\"phase\":\"" + phase + "\",\"code\":" + std::to_string(startup) + "}");
            for (const auto name : { "tcp4", "tcp6", "udp4", "udp6" }) report(name, false, static_cast<DWORD>(startup), false);
        } else {
        network(false, false, static_cast<unsigned short>(boundedNumber(argv[2], 65535)), "tcp4", bindLoopback);
        network(true, false, static_cast<unsigned short>(boundedNumber(argv[3], 65535)), "tcp6", bindLoopback);
        network(false, true, static_cast<unsigned short>(boundedNumber(argv[4], 65535)), "udp4", bindLoopback);
        network(true, true, static_cast<unsigned short>(boundedNumber(argv[5], 65535)), "udp6", bindLoopback);
        // argv[6] is reserved for a separate DNS probe. No DNS policy is inferred.
        WSACleanup();
        }
        if (phase == "primary" && !primaryOnly) {
            const std::wstring image = root + L"\\package\\probe.exe";
            std::wstring command = quote(image);
            for (int n = 1; n <= 8; ++n) command += L" " + quote(argv[n]);
            command += L" descendant";
            HANDLE inherited[3] = { GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE) };
            SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes); std::vector<BYTE> storage(bytes);
            auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)) throw WinError("descendant-attributes");
            if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)) { DeleteProcThreadAttributeList(attributes); throw WinError("descendant-handles"); }
            STARTUPINFOEXW startupInfo = {}; startupInfo.StartupInfo.cb = sizeof(startupInfo); startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startupInfo.StartupInfo.hStdInput = inherited[0]; startupInfo.StartupInfo.hStdOutput = inherited[1]; startupInfo.StartupInfo.hStdError = inherited[2]; startupInfo.lpAttributeList = attributes;
            PROCESS_INFORMATION child = {};
            if (!CreateProcessW(image.c_str(), &command[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startupInfo.StartupInfo, &child)) throw WinError("descendant-create");
            Handle process(child.hProcess), thread(child.hThread);
            emit("{\"type\":\"descendant\",\"pid\":" + std::to_string(child.dwProcessId) + "}");
            PROCESS_INFORMATION escape = {};
            if (CreateProcessW(image.c_str(), &command[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startupInfo.StartupInfo, &escape)) {
                Handle escaping(escape.hProcess), escapeThread(escape.hThread);
                EmergencyStop stop{escaping.value};
                emit("{\"type\":\"escaped\",\"pid\":" + std::to_string(escape.dwProcessId) + "}");
                if (!TerminateProcess(escaping.value, 43) || WaitForSingleObject(escaping.value, 5000) != WAIT_OBJECT_0) throw WinError("escaped-stop");
                report("breakaway", true, 0);
            } else report("breakaway", false, GetLastError());
            DeleteProcThreadAttributeList(attributes);
            if (life == L"fail") {
                const ULONGLONG deadline = GetTickCount64() + 12000;
                while (GetFileAttributesW((root + L"\\scratch\\descendant.ready").c_str()) == INVALID_FILE_ATTRIBUTES) {
                    if (GetTickCount64() >= deadline || WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) throw WinError("failure-probe-not-ready", WAIT_TIMEOUT);
                    Sleep(20);
                }
                return 17;
            }
            if (life != L"hold" && WaitForSingleObject(process.value, 12000) != WAIT_OBJECT_0) throw WinError("descendant-exit", WAIT_TIMEOUT);
            if (life != L"hold") { DWORD code = 1; if (!GetExitCodeProcess(process.value, &code) || code != 0) throw WinError("descendant-code", code); }
        }
        if (life == L"fail" && primaryOnly) return 17;
        // In the observed error variation, publish the pipe receipt before the
        // marker lets the parent exit and the Job terminate this descendant.
        const bool reportBeforeMarker = bindLoopback && life == L"fail" && phase == "descendant";
        if (reportBeforeMarker) emit("{\"type\":\"ready\",\"phase\":\"" + phase + "\"}");
        if (life == L"fail" && phase == "descendant") {
            Handle ready(CreateFileW((root + L"\\scratch\\descendant.ready").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, 0, nullptr));
            if (ready.value == INVALID_HANDLE_VALUE) throw WinError("failure-ready");
        }
        if (!reportBeforeMarker) emit("{\"type\":\"ready\",\"phase\":\"" + phase + "\"}");
        if (life == L"hold" || (life == L"fail" && phase == "descendant")) Sleep(INFINITE);
        return 0;
    } catch (const WinError& error) { try { emit("{\"type\":\"probe-error\",\"phase\":\"" + phase + "\",\"stage\":\"" + std::string(error.what()) + "\",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {} }
    return 1;
}
