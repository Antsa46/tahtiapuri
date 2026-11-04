#include "capability-diagnostic.h"

// Fixed, development-only diagnosis. Never opens sockets or changes policy.
static std::string phase;
static HANDLE reportFile = nullptr;
static void record(const std::string& line) {
    if (!reportFile) { emit(line); return; }
    const std::string data = line + "\n"; DWORD written = 0;
    if (!WriteFile(reportFile, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) || written != data.size()) throw WinError("startup-file-report");
}
static void identity() {
    const auto view = inspectToken(GetCurrentProcess()); BOOL inJob = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), nullptr, &inJob)) throw WinError("startup-job");
    record("{\"type\":\"token\",\"phase\":\"" + phase + "\",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"job\":" + (inJob ? "true" : "false") + ",\"appContainer\":" + (view.app ? "true" : "false") + ",\"lpac\":" + jsonFlag(view.lpac) + ",\"lpacQueryError\":" + std::to_string(view.lpacQueryError) + ",\"lpacQueryBytes\":" + std::to_string(view.lpacQueryBytes) + ",\"lpacQueryAttempted\":" + (view.app ? "true" : "false") + ",\"lpacQueryApi\":\"GetTokenInformation\",\"lpacInfoClass\":" + std::to_string(static_cast<int>(TokenIsLessPrivilegedAppContainer)) + ",\"lpacBufferBytes\":4,\"capabilitySids\":" + capabilityJson(inspectCapabilities(GetCurrentProcess())) + ",\"capabilities\":" + std::to_string(view.capabilities) + ",\"integrity\":" + std::to_string(view.integrity) + ",\"sid\":\"" + ascii(view.sid) + "\"}");
    unsigned valid = 0; std::string handles;
    for (const auto kind : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
        DWORD flags = 0; const HANDLE handle = GetStdHandle(kind);
        const bool ok = GetHandleInformation(handle, &flags) != FALSE; const DWORD error = ok ? 0 : GetLastError();
        SetLastError(0); const DWORD type = GetFileType(handle); const DWORD typeError = type == FILE_TYPE_UNKNOWN ? GetLastError() : 0;
        if (ok) ++valid; if (!handles.empty()) handles += ",";
        const char* name = kind == STD_INPUT_HANDLE ? "stdin" : kind == STD_OUTPUT_HANDLE ? "stdout" : "stderr";
        handles += "{\"name\":\"" + std::string(name) + "\",\"queryOk\":" + (ok ? "true" : "false") + ",\"flags\":" + std::to_string(flags) + ",\"error\":" + std::to_string(error) + ",\"type\":" + std::to_string(type) + ",\"typeError\":" + std::to_string(typeError) + "}";
    }
    record("{\"type\":\"startup-handles\",\"phase\":\"" + phase + "\",\"validStdio\":" + std::to_string(valid) + ",\"handles\":[" + handles + "]}");
}
static void readFixture(const std::wstring& path, const char* name) {
    Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    bool ok = file.value != INVALID_HANDLE_VALUE; DWORD code = ok ? 0 : GetLastError();
    if (ok) { char data[64]; DWORD read = 0; ok = ReadFile(file.value, data, sizeof(data), &read, nullptr) != FALSE; if (!ok) code = GetLastError(); }
    record("{\"type\":\"startup-read\",\"phase\":\"" + phase + "\",\"name\":\"" + name + "\",\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + "}");
}
struct Attributes {
    std::vector<BYTE> bytes; LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    Attributes() {
        SIZE_T length = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &length); bytes.resize(length);
        value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
        if (!InitializeProcThreadAttributeList(value, 1, 0, &length)) { value = nullptr; throw WinError("startup-attributes"); }
    }
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};
int wmain(int argc, wchar_t** argv) {
    Handle file;
    try {
        if (argc != 10) throw WinError("startup-arguments", ERROR_INVALID_PARAMETER);
        const std::wstring root(argv[1]), kind(argv[7]); phase = ascii(argv[9]);
        if ((phase != "primary" && phase != "descendant") || (kind != L"startup-child" && kind != L"startup-no-inherit" && kind != L"startup-winsock") || (kind == L"startup-winsock" && phase != "primary")) throw WinError("startup-mode", ERROR_INVALID_PARAMETER);
        if (phase == "descendant" && kind == L"startup-no-inherit") {
            file.value = CreateFileW((root + L"\\scratch\\child-result.jsonl").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (file.value == INVALID_HANDLE_VALUE) throw WinError("startup-child-report"); reportFile = file.value;
        }
        identity();
        readFixture(root + L"\\package\\allowed.txt", "allowed");
        readFixture(root + L"\\package\\legacy.fixture", "aap");
        readFixture(root + L"\\private\\secret.txt", "outside");
        if (phase == "primary") {
            record("{\"type\":\"startup-begin\",\"kind\":\"" + ascii(kind) + "\",\"winsockCallsBefore\":0}");
            if (kind == L"startup-winsock") {
                WSADATA data = {}; const int code = WSAStartup(MAKEWORD(2, 2), &data);
                record("{\"type\":\"startup-result\",\"api\":\"WSAStartup\",\"ok\":" + std::string(code == 0 ? "true" : "false") + ",\"code\":" + std::to_string(code) + ",\"requestedVersion\":514,\"version\":" + (code == 0 ? std::to_string(data.wVersion) : "null") + "}");
                if (code == 0) {
                    const int closed = WSACleanup(); const int error = closed == 0 ? 0 : WSAGetLastError();
                    record("{\"type\":\"startup-winsock-cleanup\",\"ok\":" + std::string(closed == 0 ? "true" : "false") + ",\"code\":" + std::to_string(error) + "}");
                }
            } else {
                const bool inherit = kind == L"startup-child";
                const std::wstring image = root + L"\\package\\probe.exe";
                std::wstring command = quote(image); for (int n = 1; n <= 8; ++n) command += L" " + quote(argv[n]); command += L" descendant";
                STARTUPINFOEXW info = {}; info.StartupInfo.cb = inherit ? sizeof(info) : sizeof(STARTUPINFOW);
                // No-inherit also uses a scratch receipt; do not attribute a change
                // to one particular handle or ACL without a narrower experiment.
                HANDLE handles[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
                Attributes attributes;
                if (inherit) {
                    if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) throw WinError("startup-handles");
                    info.lpAttributeList = attributes.value; info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    info.StartupInfo.hStdInput = handles[0]; info.StartupInfo.hStdOutput = handles[1]; info.StartupInfo.hStdError = handles[2];
                }
                PROCESS_INFORMATION child = {};
                const BOOL made = CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, inherit, CREATE_NO_WINDOW | (inherit ? EXTENDED_STARTUPINFO_PRESENT : 0), nullptr, nullptr, &info.StartupInfo, &child);
                const DWORD code = made ? 0 : GetLastError();
                Handle process(child.hProcess), thread(child.hThread);
                // Publish owned PID before any subsequent operation can fail.
                if (made) record("{\"type\":\"descendant\",\"pid\":" + std::to_string(child.dwProcessId) + "}");
                record("{\"type\":\"startup-result\",\"api\":\"CreateProcessW\",\"ok\":" + std::string(made ? "true" : "false") + ",\"code\":" + std::to_string(code) + ",\"inheritHandles\":" + (inherit ? "true" : "false") + "}");
                if (made) {
                    if (WaitForSingleObject(process.value, 10000) != WAIT_OBJECT_0) throw WinError("startup-child-timeout", WAIT_TIMEOUT);
                    DWORD exit = 1; if (!GetExitCodeProcess(process.value, &exit)) throw WinError("startup-child-exit");
                    record("{\"type\":\"startup-child-exit\",\"pid\":" + std::to_string(child.dwProcessId) + ",\"exitCode\":" + std::to_string(exit) + "}");
                }
            }
        }
        record("{\"type\":\"startup-complete\",\"phase\":\"" + phase + "\"}");
        return 0; // Completed diagnosis is distinct from the observed API success.
    } catch (const WinError& error) { try { record("{\"type\":\"probe-error\",\"phase\":\"" + phase + "\",\"stage\":\"" + error.what() + "\",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {} }
    return 1;
}
