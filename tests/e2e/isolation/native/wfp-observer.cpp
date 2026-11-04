#include "common.h"
#include <fwpmu.h>
#include <fwpmtypes.h>
#include <rpc.h>
#include <mutex>
#include <deque>
#include <atomic>
#include <thread>
#pragma comment(lib, "Fwpuclnt.lib")
#pragma comment(lib, "Rpcrt4.lib")

// Trusted development-only observer. No engine writes, process launches or policy changes.
static std::string hex(const BYTE* data, size_t size) {
    if (size > 65536 || (size && !data)) throw WinError("invalid-blob", ERROR_INVALID_DATA);
    std::string out; out.reserve(size * 2); const char* digits = "0123456789abcdef";
    for (size_t i = 0; i < size; ++i) { out += digits[data[i] >> 4]; out += digits[data[i] & 15]; }
    return out;
}
static std::string json(const std::wstring& value) {
    if (value.size() > 32768) throw WinError("long-string", ERROR_INVALID_DATA);
    const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!value.empty() && !n) throw WinError("utf8");
    std::string raw(static_cast<size_t>(n), '\0');
    if (n && !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), raw.data(), n, nullptr, nullptr)) throw WinError("utf8");
    std::string out = "\"";
    for (unsigned char c : raw) { if (c == '"' || c == '\\') out += '\\'; if (c < 32) { const BYTE b = c; out += "\\u00" + hex(&b, 1); } else out += static_cast<char>(c); }
    return out + "\"";
}
static std::string guid(const GUID& value) {
    RPC_WSTR text = nullptr; if (UuidToStringW(&value, &text) != RPC_S_OK) throw WinError("guid", ERROR_INVALID_DATA);
    const std::wstring copy(reinterpret_cast<wchar_t*>(text)); RpcStringFreeW(&text); return json(copy);
}
static ULONGLONG milliseconds(const FILETIME& time) {
    ULARGE_INTEGER value = {}; value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
    if (value.QuadPart < 116444736000000000ULL) throw WinError("timestamp", ERROR_INVALID_DATA);
    return (value.QuadPart - 116444736000000000ULL) / 10000;
}
struct Blob { FWP_BYTE_BLOB* value = nullptr; ~Blob() { if (value) FwpmFreeMemory0(reinterpret_cast<void**>(&value)); } };
struct Engine { HANDLE value = nullptr; ~Engine() { if (value) FwpmEngineClose0(value); } };
struct Subscription { HANDLE engine = nullptr, value = nullptr; ~Subscription() { if (value) FwpmNetEventUnsubscribe0(engine, value); } };
struct Writer {
    Handle file; size_t bytes = 0;
    explicit Writer(const std::wstring& path) : file(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)) { if (file.value == INVALID_HANDLE_VALUE) throw WinError("output-create"); }
    void line(const std::string& value) {
        const std::string text = value + "\n";
        if (bytes + text.size() > 8 * 1024 * 1024) throw WinError("output-limit", ERROR_FILE_TOO_LARGE);
        DWORD written = 0; if (!WriteFile(file.value, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) || written != text.size() || !FlushFileBuffers(file.value)) throw WinError("output-write");
        bytes += text.size();
    }
};
static UINT64 option(HANDLE engine, FWPM_ENGINE_OPTION name) {
    FWP_VALUE0* raw = nullptr; const DWORD status = FwpmEngineGetOption0(engine, name, &raw);
    if (status) throw WinError("engine-option", status);
    UINT64 result = 0; const bool valid = raw && (raw->type == FWP_UINT32 || (raw->type == FWP_UINT64 && raw->uint64));
    if (valid) result = raw->type == FWP_UINT32 ? raw->uint32 : *raw->uint64;
    if (raw) FwpmFreeMemory0(reinterpret_cast<void**>(&raw));
    if (!valid) throw WinError("engine-option-type", ERROR_INVALID_DATA);
    return result;
}
static std::string conditionValue(const FWP_CONDITION_VALUE0& v) {
    std::string result = "{\"type\":" + std::to_string(v.type);
    switch (v.type) {
    case FWP_UINT8: result += ",\"value\":" + std::to_string(v.uint8); break;
    case FWP_UINT16: result += ",\"value\":" + std::to_string(v.uint16); break;
    case FWP_UINT32: result += ",\"value\":" + std::to_string(v.uint32); break;
    case FWP_UINT64: if (!v.uint64) throw WinError("condition-u64", ERROR_INVALID_DATA); result += ",\"value\":\"" + std::to_string(*v.uint64) + "\""; break;
    case FWP_SID: if (!v.sid || !IsValidSid(v.sid)) throw WinError("condition-sid", ERROR_INVALID_DATA); result += ",\"hex\":\"" + hex(reinterpret_cast<BYTE*>(v.sid), GetLengthSid(v.sid)) + "\""; break;
    case FWP_SECURITY_DESCRIPTOR_TYPE: if (!v.sd) throw WinError("condition-sd", ERROR_INVALID_DATA); result += ",\"hex\":\"" + hex(v.sd->data, v.sd->size) + "\""; break;
    case FWP_BYTE_BLOB_TYPE: if (!v.byteBlob) throw WinError("condition-blob", ERROR_INVALID_DATA); result += ",\"hex\":\"" + hex(v.byteBlob->data, v.byteBlob->size) + "\""; break;
    default: result += ",\"unsupported\":true"; break;
    }
    return result + "}";
}
static std::string filter(HANDLE engine, UINT64 id) {
    FWPM_FILTER0* value = nullptr; const DWORD status = FwpmFilterGetById0(engine, id, &value);
    if (status) return "{\"queryCode\":" + std::to_string(status) + "}";
    try {
        if (!value || value->numFilterConditions > 256) throw WinError("filter-shape", ERROR_INVALID_DATA);
        std::string result = "{\"queryCode\":0,\"id\":\"" + std::to_string(value->filterId) + "\",\"key\":" + guid(value->filterKey) + ",\"provider\":" + (value->providerKey ? guid(*value->providerKey) : "null") + ",\"layer\":" + guid(value->layerKey) + ",\"sublayer\":" + guid(value->subLayerKey) + ",\"flags\":" + std::to_string(value->flags) + ",\"actionType\":" + std::to_string(value->action.type) + ",\"name\":" + json(value->displayData.name ? value->displayData.name : L"") + ",\"conditions\":[";
        for (UINT32 i = 0; i < value->numFilterConditions; ++i) { const auto& c = value->filterCondition[i]; if (i) result += ','; result += "{\"field\":" + guid(c.fieldKey) + ",\"match\":" + std::to_string(c.matchType) + ",\"value\":" + conditionValue(c.conditionValue) + "}"; }
        FwpmFreeMemory0(reinterpret_cast<void**>(&value)); return result + "]}";
    } catch (...) { if (value) FwpmFreeMemory0(reinterpret_cast<void**>(&value)); throw; }
}
struct Event { std::string record; UINT64 filterId = 0; };
struct Context { std::mutex mutex; std::deque<Event> pending; std::string appId; std::atomic<bool> failed{false}; size_t total = 0; };
static void CALLBACK receive(void* pointer, const FWPM_NET_EVENT2* event) noexcept {
    auto& context = *static_cast<Context*>(pointer);
    try {
        if (!event || !(event->header.flags & FWPM_NET_EVENT_FLAG_APP_ID_SET)) return;
        const auto& h = event->header; const std::string appId = hex(h.appId.data, h.appId.size); if (appId != context.appId) return;
        std::lock_guard<std::mutex> lock(context.mutex);
        if (++context.total > 256 || context.pending.size() >= 256) { context.failed = true; return; }
        Event item; item.record = "{\"kind\":\"event\",\"type\":" + std::to_string(event->type) + ",\"flags\":" + std::to_string(h.flags) + ",\"atMs\":" + std::to_string(milliseconds(h.timeStamp)) + ",\"appIdHex\":\"" + appId + "\"";
        if ((h.flags & FWPM_NET_EVENT_FLAG_PACKAGE_ID_SET) && h.packageSid && IsValidSid(h.packageSid)) { LPWSTR sid = nullptr; if (!ConvertSidToStringSidW(h.packageSid, &sid)) throw WinError("event-sid"); const std::wstring copy(sid); LocalFree(sid); item.record += ",\"packageSid\":" + json(copy); }
        if (h.flags & FWPM_NET_EVENT_FLAG_IP_PROTOCOL_SET) item.record += ",\"protocol\":" + std::to_string(h.ipProtocol);
        if (h.flags & FWPM_NET_EVENT_FLAG_LOCAL_PORT_SET) item.record += ",\"localPort\":" + std::to_string(h.localPort);
        if (h.flags & FWPM_NET_EVENT_FLAG_REMOTE_PORT_SET) item.record += ",\"remotePort\":" + std::to_string(h.remotePort);
        if (h.flags & FWPM_NET_EVENT_FLAG_IP_VERSION_SET) {
            item.record += ",\"ipVersion\":" + std::to_string(h.ipVersion);
            // WFP IPv4 values are host order; preserve raw bytes for exact, reviewed decoding.
            if (h.flags & FWPM_NET_EVENT_FLAG_LOCAL_ADDR_SET) item.record += ",\"localAddressHex\":\"" + (h.ipVersion == FWP_IP_VERSION_V4 ? hex(reinterpret_cast<const BYTE*>(&h.localAddrV4), 4) : h.ipVersion == FWP_IP_VERSION_V6 ? hex(h.localAddrV6.byteArray16, 16) : "") + "\"";
            if (h.flags & FWPM_NET_EVENT_FLAG_REMOTE_ADDR_SET) item.record += ",\"remoteAddressHex\":\"" + (h.ipVersion == FWP_IP_VERSION_V4 ? hex(reinterpret_cast<const BYTE*>(&h.remoteAddrV4), 4) : h.ipVersion == FWP_IP_VERSION_V6 ? hex(h.remoteAddrV6.byteArray16, 16) : "") + "\"";
        }
        if (event->type == FWPM_NET_EVENT_TYPE_CLASSIFY_DROP && event->classifyDrop) { const auto& d = *event->classifyDrop; item.filterId = d.filterId; item.record += ",\"classifyDrop\":true,\"filterId\":\"" + std::to_string(d.filterId) + "\",\"layerId\":" + std::to_string(d.layerId) + ",\"direction\":" + std::to_string(d.msFwpDirection) + ",\"loopback\":" + (d.isLoopback ? "true" : "false"); }
        context.pending.push_back(std::move(item));
    } catch (...) { context.failed = true; }
}
static std::wstring executableDirectory() {
    std::vector<wchar_t> path(32768); const DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!n || n >= path.size()) throw WinError("own-image"); const std::wstring value(path.data(), n); return value.substr(0, value.find_last_of(L'\\'));
}
static void checkPath(const std::wstring& path) {
    for (size_t i = 3; i <= path.size(); ++i) if (i == path.size() || path[i] == L'\\') { const auto part = path.substr(0, i); const DWORD attributes = GetFileAttributesW(part.c_str()); if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw WinError("path-reparse-or-missing", ERROR_INVALID_DATA); }
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 64;
    const std::wstring id(argv[1]);
    if (id.size() != 36 || !std::all_of(id.begin(), id.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-'; })) return 64;
    // This program can read only the fixed native probe image in this owned run.
    std::wstring base = executableDirectory(); base = base.substr(0, base.find_last_of(L'\\')); base = base.substr(0, base.find_last_of(L'\\'));
    const std::wstring run = base + L"\\runs\\" + id, output = run + L"\\wfp";
    Handle done(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!done.value) return 65;
    std::thread watchdog([&] { if (WaitForSingleObject(done.value, 60000) != WAIT_OBJECT_0) TerminateProcess(GetCurrentProcess(), 124); });
    int exitCode = 1;
    try {
        checkPath(run);
        Handle owner(OpenProcess(SYNCHRONIZE, FALSE, boundedNumber(argv[2], MAXDWORD))); if (!owner.value || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) throw WinError("owner-unavailable", ERROR_INVALID_HANDLE);
        HANDLE tokenRaw = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenRaw)) throw WinError("own-token"); Handle token(tokenRaw);
        auto user = tokenInfo(token.value, TokenUser); LPWSTR sid = nullptr; if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid)) throw WinError("own-user");
        const std::wstring descriptor = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sid) + L")"; LocalFree(sid);
        PSECURITY_DESCRIPTOR security = nullptr; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(), SDDL_REVISION_1, &security, nullptr)) throw WinError("output-acl");
        SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE }; const BOOL made = CreateDirectoryW(output.c_str(), &attributes); const DWORD directoryError = made ? 0 : GetLastError(); LocalFree(security); if (!made) throw WinError("output-directory", directoryError);
        Handle directory(CreateFileW(output.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); if (directory.value == INVALID_HANDLE_VALUE) throw WinError("output-lock");
        Writer log(output + L"\\events.jsonl");
        try {
            Context context; Engine engine; FWPM_SESSION0 session = {}; session.flags = FWPM_SESSION_FLAG_DYNAMIC; session.txnWaitTimeoutInMSec = 1000;
            DWORD status = UuidCreate(&session.sessionKey); if (status != RPC_S_OK && status != RPC_S_UUID_LOCAL_ONLY) throw WinError("session-guid", status);
            status = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &engine.value); if (status) throw WinError("engine-open", status);
            const auto collectBefore = option(engine.value, FWPM_ENGINE_COLLECT_NET_EVENTS), keywordsBefore = option(engine.value, FWPM_ENGINE_NET_EVENT_MATCH_ANY_KEYWORDS);
            log.line("{\"kind\":\"baseline\",\"session\":" + guid(session.sessionKey) + ",\"collect\":" + std::to_string(collectBefore) + ",\"keywords\":\"" + std::to_string(keywordsBefore) + "\"}");
            if (collectBefore != 1) throw WinError("collection-not-enabled-no-settings-changed", ERROR_NOT_READY);
            Blob app; status = FwpmGetAppIdFromFileName0((run + L"\\ac-normal\\staged\\package\\probe.exe").c_str(), &app.value); if (status) throw WinError("app-id", status);
            if (!app.value || !app.value->size) throw WinError("empty-app-id", ERROR_INVALID_DATA); context.appId = hex(app.value->data, app.value->size);
            FWPM_FILTER_CONDITION0 condition = {}; condition.fieldKey = FWPM_CONDITION_ALE_APP_ID; condition.matchType = FWP_MATCH_EQUAL; condition.conditionValue.type = FWP_BYTE_BLOB_TYPE; condition.conditionValue.byteBlob = app.value;
            FWPM_NET_EVENT_ENUM_TEMPLATE0 selection = {}; GetSystemTimeAsFileTime(&selection.startTime); ULARGE_INTEGER end = {}; end.LowPart = selection.startTime.dwLowDateTime; end.HighPart = selection.startTime.dwHighDateTime; end.QuadPart += 60ULL * 10000000; selection.endTime.dwLowDateTime = end.LowPart; selection.endTime.dwHighDateTime = end.HighPart; selection.numFilterConditions = 1; selection.filterCondition = &condition;
            FWPM_NET_EVENT_SUBSCRIPTION0 request = {}; request.enumTemplate = &selection; request.sessionKey = session.sessionKey;
            Subscription subscription; subscription.engine = engine.value; status = FwpmNetEventSubscribe1(engine.value, &request, receive, &context, &subscription.value); if (status) throw WinError("subscribe", status);
            log.line("{\"kind\":\"ready\",\"appIdHex\":\"" + context.appId + "\"}"); { Writer ready(output + L"\\ready.json"); ready.line("{\"ready\":true}"); }
            const ULONGLONG deadline = GetTickCount64() + 45000; bool stopped = false;
            auto drain = [&] { std::deque<Event> events; { std::lock_guard<std::mutex> lock(context.mutex); events.swap(context.pending); } for (auto& event : events) { if (event.filterId) event.record += ",\"filter\":" + filter(engine.value, event.filterId); log.line(event.record + "}"); } };
            while (!context.failed && GetTickCount64() < deadline) {
                drain(); if (GetFileAttributesW((run + L"\\stop-wfp.request").c_str()) != INVALID_FILE_ATTRIBUTES) { stopped = true; break; }
                if (WaitForSingleObject(owner.value, 25) != WAIT_TIMEOUT) break;
            }
            status = FwpmNetEventUnsubscribe0(engine.value, subscription.value); if (status) throw WinError("unsubscribe", status); subscription.value = nullptr; drain();
            const auto collectAfter = option(engine.value, FWPM_ENGINE_COLLECT_NET_EVENTS), keywordsAfter = option(engine.value, FWPM_ENGINE_NET_EVENT_MATCH_ANY_KEYWORDS);
            const bool stable = collectBefore == collectAfter && keywordsBefore == keywordsAfter;
            status = FwpmEngineClose0(engine.value); if (status) throw WinError("engine-close", status); engine.value = nullptr;
            const bool complete = stopped && !context.failed && stable;
            log.line("{\"kind\":\"finished\",\"complete\":" + std::string(complete ? "true" : "false") + ",\"unsubscribed\":true,\"engineClosed\":true,\"optionsUnchanged\":" + (stable ? "true" : "false") + ",\"collectAfter\":" + std::to_string(collectAfter) + ",\"keywordsAfter\":\"" + std::to_string(keywordsAfter) + "\",\"matchedEvents\":" + std::to_string(context.total) + "}");
            exitCode = complete ? 0 : 2;
        } catch (const WinError& error) { log.line("{\"kind\":\"error\",\"stage\":" + json(std::wstring(error.what(), error.what() + strlen(error.what()))) + ",\"code\":" + std::to_string(error.code) + "}"); }
          catch (...) { log.line("{\"kind\":\"error\",\"stage\":\"unexpected\"}"); }
        { Writer finished(output + L"\\done.json"); finished.line("{\"exitCode\":" + std::to_string(exitCode) + "}"); }
    } catch (...) { exitCode = 1; /* Missing receipt is a failure; no global state was modified. */ }
    SetEvent(done.value); watchdog.join(); return exitCode;
}
