#include "observation-support.h"
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <array>
#pragma comment(lib, "Tdh.lib")

// Development-only, real-time ETW session. No engine settings, ETL or AutoLogger.
static const GUID provider = { 0x0c478c5b, 0x0351, 0x41b1, {0x8c,0x58,0x4a,0x67,0x37,0xda,0x32,0xe3} };
struct TraceProperties {
    EVENT_TRACE_PROPERTIES value = {}; wchar_t name[128] = {};
    TraceProperties(const GUID& id) {
        value.Wnode.BufferSize = sizeof(*this); value.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        value.Wnode.Guid = id; value.Wnode.ClientContext = 1;
        value.BufferSize = 32; value.MinimumBuffers = 4; value.MaximumBuffers = 4;
        value.LogFileMode = EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING;
        value.FlushTimer = 1; value.LoggerNameOffset = offsetof(TraceProperties, name);
    }
};
struct Run {
    GUID id = {}; std::wstring root, output, name, image;
    explicit Run(const std::wstring& text) {
        if (text.size() != 36 || !std::all_of(text.begin(), text.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || c == L'-'; }) || UuidFromStringW(reinterpret_cast<RPC_WSTR>(const_cast<wchar_t*>(text.c_str())), &id) != RPC_S_OK) throw WinError("run-id", ERROR_INVALID_PARAMETER);
        const auto bin = executableDirectory(); image = bin + L"\\etw-observer.exe";
        auto base = bin.substr(0, bin.find_last_of(L'\\')); base = base.substr(0, base.find_last_of(L'\\'));
        root = base + L"\\runs\\" + text; output = root + L"\\etw"; name = L"Tahtiapuri.Probe." + text; checkPath(root);
    }
};
static bool exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }
static bool absent(const Run& run) {
    TraceProperties query(run.id); const ULONG code = ControlTraceW(0, run.name.c_str(), &query.value, EVENT_TRACE_CONTROL_QUERY);
    if (code == ERROR_WMI_INSTANCE_NOT_FOUND) return true;
    if (code) throw WinError("session-query", code);
    if (!IsEqualGUID(query.value.Wnode.Guid, run.id)) throw WinError("session-identity", ERROR_INVALID_DATA);
    return false;
}
static void stopOwned(const Run& run) {
    if (absent(run)) return;
    TraceProperties stop(run.id); const ULONG code = ControlTraceW(0, run.name.c_str(), &stop.value, EVENT_TRACE_CONTROL_STOP);
    if (code != ERROR_SUCCESS && code != ERROR_WMI_INSTANCE_NOT_FOUND) throw WinError("guard-stop", code);
    if (!absent(run)) throw WinError("session-remains", ERROR_BUSY);
}
static int guard(const Run& run, DWORD controllerPid) {
    checkPath(run.output);
    Handle controller(OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, controllerPid));
    if (!controller.value) throw WinError("guard-controller");
    std::vector<wchar_t> actual(32768); DWORD length = static_cast<DWORD>(actual.size());
    if (!QueryFullProcessImageNameW(controller.value, 0, actual.data(), &length) || _wcsicmp(std::wstring(actual.data(), length).c_str(), run.image.c_str()) != 0) throw WinError("guard-image", ERROR_INVALID_DATA);
    if (!absent(run)) throw WinError("preexisting-session", ERROR_ALREADY_EXISTS);
    { Writer ready(run.output + L"\\guard-ready.json"); ready.line("{\"ready\":true}"); }
    const auto deadline = GetTickCount64() + 60000; bool timedOut = false;
    while (!exists(run.output + L"\\guard-stop.request") && WaitForSingleObject(controller.value, 25) == WAIT_TIMEOUT) {
        if (GetTickCount64() >= deadline) { timedOut = true; if (!TerminateProcess(controller.value, 124)) throw WinError("guard-terminate"); if (WaitForSingleObject(controller.value, 5000) != WAIT_OBJECT_0) throw WinError("controller-remains", ERROR_TIMEOUT); break; }
    }
    stopOwned(run);
    Writer done(run.output + L"\\guard-done.json");
    done.line("{\"cleanupPassed\":true,\"sessionAbsent\":true,\"identityVerified\":true,\"timedOut\":" + std::string(timedOut ? "true" : "false") + "}");
    return timedOut ? 2 : 0;
}
static std::vector<BYTE> property(EVENT_RECORD* event, const wchar_t* name) {
    PROPERTY_DATA_DESCRIPTOR descriptor = {}; descriptor.PropertyName = reinterpret_cast<ULONGLONG>(name); descriptor.ArrayIndex = ULONG_MAX;
    ULONG size = 0; ULONG code = TdhGetPropertySize(event, 0, nullptr, 1, &descriptor, &size);
    if (code || size > 65536) throw WinError(("event-property-size-" + ascii(name)).c_str(), code ? code : ERROR_INVALID_DATA);
    std::vector<BYTE> data(size); code = TdhGetProperty(event, 0, nullptr, 1, &descriptor, size, data.data());
    if (code) throw WinError(("event-property-" + ascii(name)).c_str(), code); return data;
}
template<class T> static T scalar(EVENT_RECORD* event, const wchar_t* name) {
    const auto data = property(event, name); if (data.size() != sizeof(T)) throw WinError(("event-scalar-" + ascii(name) + "-bytes-" + std::to_string(data.size()) + "-expected-" + std::to_string(sizeof(T))).c_str(), ERROR_INVALID_DATA);
    T value; memcpy(&value, data.data(), sizeof(value)); return value;
}
struct Endpoint { int family = 0; unsigned short port = 0; bool loopback = false; };
static Endpoint endpoint(const std::vector<BYTE>& data) {
    Endpoint result;
    if (data.size() == sizeof(sockaddr_in)) {
        sockaddr_in value = {}; memcpy(&value, data.data(), sizeof(value));
        if (value.sin_family != AF_INET) throw WinError("socket-family", ERROR_INVALID_DATA);
        result = { AF_INET, ntohs(value.sin_port), value.sin_addr.s_addr == htonl(INADDR_LOOPBACK) };
    } else if (data.size() == sizeof(sockaddr_in6)) {
        sockaddr_in6 value = {}; memcpy(&value, data.data(), sizeof(value));
        if (value.sin6_family != AF_INET6) throw WinError("socket-family", ERROR_INVALID_DATA);
        result = { AF_INET6, ntohs(value.sin6_port), IN6_IS_ADDR_LOOPBACK(&value.sin6_addr) != 0 };
    } else throw WinError("socket-size", ERROR_INVALID_DATA);
    return result;
}
static bool ownedEndpoints(const Endpoint& local, const Endpoint& remote, const std::array<unsigned short, 4>& ports, bool listening = false) {
    if (!local.loopback || !remote.loopback || local.family != remote.family) return false;
    const size_t first = local.family == AF_INET ? 0 : 1;
    for (size_t i = first; i < ports.size(); i += 2) if (ports[i] && (listening ? local.port : remote.port) == ports[i]) return true;
    return false;
}
static void checkEndpoints() {
    const std::array<unsigned short, 4> ports = {32001, 32002, 32003, 32004};
    const Endpoint v4 = {AF_INET, 32001, true}, peer4 = {AF_INET, 12345, true};
    const Endpoint v6 = {AF_INET6, 32002, true}, peer6 = {AF_INET6, 12345, true};
    if (!ownedEndpoints(v4, peer4, ports, true) || !ownedEndpoints(peer4, v4, ports) || !ownedEndpoints(v6, peer6, ports, true) || !ownedEndpoints(peer6, v6, ports)) throw WinError("endpoint-positive", ERROR_INVALID_DATA);
    if (ownedEndpoints(v4, {AF_INET, 12345, false}, ports) || ownedEndpoints(v6, {AF_INET6, 12345, false}, ports) || ownedEndpoints(peer4, peer4, ports) || ownedEndpoints(v4, v6, ports)) throw WinError("endpoint-negative", ERROR_INVALID_DATA);
    bool rejected = false; try { endpoint(std::vector<BYTE>(1)); } catch (const WinError&) { rejected = true; }
    if (!rejected) throw WinError("endpoint-size-test", ERROR_INVALID_DATA);
    // Check the real socket decoding too, including network byte order and address bytes.
    sockaddr_in wire4 = {}; wire4.sin_family = AF_INET; wire4.sin_port = htons(32003); wire4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    std::vector<BYTE> bytes4(sizeof(wire4)); memcpy(bytes4.data(), &wire4, sizeof(wire4));
    if (!ownedEndpoints(endpoint(bytes4), peer4, ports, true)) throw WinError("endpoint-v4-decode", ERROR_INVALID_DATA);
    sockaddr_in6 wire6 = {}; wire6.sin6_family = AF_INET6; wire6.sin6_port = htons(32004); wire6.sin6_addr = in6addr_loopback;
    std::vector<BYTE> bytes6(sizeof(wire6)); memcpy(bytes6.data(), &wire6, sizeof(wire6));
    if (!ownedEndpoints(endpoint(bytes6), peer6, ports, true)) throw WinError("endpoint-v6-decode", ERROR_INVALID_DATA);
    if (ownedEndpoints(v4, peer4, ports) || ownedEndpoints(peer4, v4, ports, true)) throw WinError("endpoint-side", ERROR_INVALID_DATA);
    emit("{\"endpointChecks\":13,\"passed\":true}");
}
static ULONGLONG eventMilliseconds(const EVENT_RECORD& event) {
    // ProcessTrace converts the header to system FILETIME; RAW_TIMESTAMP is not enabled.
    const FILETIME value = { event.EventHeader.TimeStamp.LowPart, static_cast<DWORD>(event.EventHeader.TimeStamp.HighPart) };
    return milliseconds(value);
}
struct Event { std::string record; UINT64 filterId = 0; };
struct Context {
    std::mutex mutex; std::deque<Event> pending; std::wstring app, dosApp, ownerApp, ownerDosApp; std::string canonicalAppId, canonicalOwnerId; std::array<unsigned short, 4> ports = {};
    size_t providerMismatch = 0, otherEventId = 0, emptyAppId = 0, otherAppId = 0, otherEndpoint = 0, ntMatches = 0, dosMatches = 0;
    std::string failureStage, failurePayload; DWORD failureCode = 0; unsigned failureVersion = 0; bool failureRecorded = false;
    std::atomic<bool> failed{false}; std::atomic<size_t> received{0}; size_t matched = 0;
};
static void captureFailure(Context& c, const EVENT_RECORD* event, bool owned, const char* stage, DWORD code) noexcept {
    if (c.failed.exchange(true)) return; // Keep one internally consistent first failure.
    try {
        c.failureCode = code; c.failureVersion = event->EventHeader.EventDescriptor.Version;
        c.failureStage = stage;
        if (owned) c.failurePayload = hex(static_cast<const BYTE*>(event->UserData), event->UserDataLength);
        c.failureRecorded = true;
    } catch (...) { /* Failed collection remains rejected even if diagnostics cannot allocate. */ }
}
static void WINAPI receiveEtw(EVENT_RECORD* event) noexcept {
    auto& c = *static_cast<Context*>(event->UserContext); bool owned = false;
    try {
        if (++c.received > 4096) throw WinError("receive-limit", ERROR_BUFFER_OVERFLOW);
        if (!IsEqualGUID(event->EventHeader.ProviderId, provider)) { ++c.providerMismatch; return; }
        if (event->EventHeader.EventDescriptor.Id != 1001) { ++c.otherEventId; return; }
        if (event->EventHeader.EventDescriptor.Version > 2) throw WinError("event-version", ERROR_NOT_SUPPORTED);
        const auto app = property(event, L"AppId");
        if (app.size() < 2 || app.size() % 2 || app[app.size()-1] || app[app.size()-2]) throw WinError("event-app-id", ERROR_INVALID_DATA);
        const auto text = std::wstring(reinterpret_cast<const wchar_t*>(app.data()), app.size()/2-1);
        if (text.find(L'\0') != std::wstring::npos) throw WinError("embedded-app-nul", ERROR_INVALID_DATA);
        if (text.empty()) { ++c.emptyAppId; return; }
        const bool probeNt = _wcsicmp(text.c_str(), c.app.c_str()) == 0;
        const bool probeDos = _wcsicmp(text.c_str(), c.dosApp.c_str()) == 0;
        const bool ownerNt = _wcsicmp(text.c_str(), c.ownerApp.c_str()) == 0;
        const bool ownerDos = _wcsicmp(text.c_str(), c.ownerDosApp.c_str()) == 0;
        if (!probeNt && !probeDos && !ownerNt && !ownerDos) { ++c.otherAppId; return; }
        const auto local = property(event, L"LocalAddress"), remote = property(event, L"RemoteAddress");
        if (!ownedEndpoints(endpoint(local), endpoint(remote), c.ports, ownerNt || ownerDos)) { ++c.otherEndpoint; return; }
        owned = true;
        const bool isProbe = probeNt || probeDos, ntMatch = probeNt || ownerNt;
        if (ntMatch) ++c.ntMatches; else ++c.dosMatches;
        const auto payloadTimestamp = scalar<UINT64>(event, L"Timestamp");
        Event item; item.filterId = scalar<UINT64>(event, L"FilterId");
        item.record = "{\"kind\":\"event\",\"eventId\":1001,\"version\":" + std::to_string(event->EventHeader.EventDescriptor.Version) + ",\"atMs\":" + std::to_string(eventMilliseconds(*event)) + ",\"timeSource\":\"etw-header-system-time\",\"payloadTimestampRaw\":\"" + std::to_string(payloadTimestamp) + "\",\"canonicalAppIdHex\":\"" + (isProbe ? c.canonicalAppId : c.canonicalOwnerId) + "\",\"identityRole\":\"" + (isProbe ? "probe" : "endpoint-owner") + "\",\"observedAppIdHex\":\"" + hex(app.data(), app.size()) + "\",\"appIdMatch\":\"" + (ntMatch ? "nt-path" : "dos-path") + "\",\"emitterPid\":" + std::to_string(event->EventHeader.ProcessId) + ",\"localSocketHex\":\"" + hex(local.data(), local.size()) + "\",\"remoteSocketHex\":\"" + hex(remote.data(), remote.size()) + "\",\"loopback\":" + std::to_string(scalar<ULONG>(event, L"Loopback")) + ",\"direction\":" + std::to_string(scalar<ULONG>(event, L"PacketDirection")) + ",\"filterId\":\"" + std::to_string(item.filterId) + "\",\"layerId\":" + std::to_string(scalar<USHORT>(event, L"LayerId"));
        std::lock_guard<std::mutex> lock(c.mutex); if (++c.matched > 256 || c.pending.size() >= 256) throw WinError("queue-limit", ERROR_BUFFER_OVERFLOW);
        c.pending.push_back(std::move(item));
    } catch (const WinError& error) { captureFailure(c, event, owned, error.what(), error.code); }
      catch (...) { captureFailure(c, event, owned, "unexpected", ERROR_UNHANDLED_EXCEPTION); }
}
static void createOutput(const Run& run) {
    HANDLE raw = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) throw WinError("own-token"); Handle token(raw);
    const auto info = tokenInfo(token.value, TokenUser); LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<const TOKEN_USER*>(info.data())->User.Sid, &sid)) throw WinError("own-sid");
    const std::wstring dacl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sid) + L")"; LocalFree(sid);
    PSECURITY_DESCRIPTOR security = nullptr; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.c_str(), SDDL_REVISION_1, &security, nullptr)) throw WinError("output-dacl");
    SECURITY_ATTRIBUTES attr = { sizeof(attr), security, FALSE }; const BOOL made = CreateDirectoryW(run.output.c_str(), &attr); const DWORD code = made ? 0 : GetLastError(); LocalFree(security); if (!made) throw WinError("output-create", code);
}
static int observe(const Run& run, DWORD ownerPid, const std::wstring& scenario, const std::array<unsigned short, 4>& ports, const std::wstring& expectedOwner) {
    createOutput(run); Handle directory(CreateFileW(run.output.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (directory.value == INVALID_HANDLE_VALUE) throw WinError("output-lock");
    Writer log(run.output + L"\\events.jsonl"); int result = 1;
    Handle owner(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, ownerPid)); if (!owner.value || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) throw WinError("owner-unavailable", ERROR_INVALID_HANDLE);
    PROCESS_INFORMATION process = {}; STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
    std::wstring command = quote(run.image) + L" " + run.name.substr(17) + L" " + std::to_wstring(GetCurrentProcessId()) + L" guard";
    if (!CreateProcessW(run.image.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) throw WinError("guard-create");
    Handle guardian(process.hProcess), guardianThread(process.hThread);
    TRACEHANDLE session = 0, consumer = INVALID_PROCESSTRACE_HANDLE; bool started = false, enabled = false;
    Context context; std::thread reader; ULONG readerCode = ERROR_INVALID_STATE; TraceProperties stopped(run.id);
    try {
        const auto waitUntil = GetTickCount64() + 5000;
        while (!exists(run.output + L"\\guard-ready.json")) {
            if (WaitForSingleObject(guardian.value, 25) != WAIT_TIMEOUT || GetTickCount64() >= waitUntil) throw WinError("guard-not-ready", ERROR_TIMEOUT);
        }
        Engine engine; FWPM_SESSION0 engineSession = {}; engineSession.flags = FWPM_SESSION_FLAG_DYNAMIC;
        DWORD code = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &engineSession, &engine.value); if (code) throw WinError("engine-open", code);
        const auto beforeCollect = option(engine.value, FWPM_ENGINE_COLLECT_NET_EVENTS), beforeKeywords = option(engine.value, FWPM_ENGINE_NET_EVENT_MATCH_ANY_KEYWORDS);
        log.line("{\"kind\":\"baseline\",\"collect\":" + std::to_string(beforeCollect) + ",\"keywords\":\"" + std::to_string(beforeKeywords) + "\"}");
        Blob app; code = FwpmGetAppIdFromFileName0((run.root + L"\\ac-normal\\staged\\package\\probe.exe").c_str(), &app.value); if (code) throw WinError("app-id", code);
        if (!app.value || app.value->size < 2 || app.value->size % 2) throw WinError("app-shape", ERROR_INVALID_DATA);
        context.app = std::wstring(reinterpret_cast<wchar_t*>(app.value->data), app.value->size/2-1);
        context.dosApp = run.root + L"\\ac-normal\\staged\\package\\probe.exe";
        context.canonicalAppId = hex(app.value->data, app.value->size); context.ports = ports;
        std::vector<wchar_t> ownerImage(32768); DWORD ownerLength = static_cast<DWORD>(ownerImage.size());
        if (!QueryFullProcessImageNameW(owner.value, 0, ownerImage.data(), &ownerLength)) throw WinError("owner-image");
        context.ownerDosApp.assign(ownerImage.data(), ownerLength);
        if (scenario == L"observe" && _wcsicmp(context.ownerDosApp.c_str(), expectedOwner.c_str()) != 0) throw WinError("owner-image-mismatch", ERROR_INVALID_DATA);
        Blob ownerApp; code = FwpmGetAppIdFromFileName0(context.ownerDosApp.c_str(), &ownerApp.value); if (code) throw WinError("owner-app-id", code);
        if (!ownerApp.value || ownerApp.value->size < 2 || ownerApp.value->size % 2) throw WinError("owner-app-shape", ERROR_INVALID_DATA);
        context.ownerApp.assign(reinterpret_cast<wchar_t*>(ownerApp.value->data), ownerApp.value->size/2-1);
        context.canonicalOwnerId = hex(ownerApp.value->data, ownerApp.value->size);
        TraceProperties props(run.id); code = StartTraceW(&session, run.name.c_str(), &props.value); if (code) throw WinError("trace-start", code); started = true;
        EVENT_TRACE_LOGFILEW logfile = {}; logfile.LoggerName = const_cast<wchar_t*>(run.name.c_str()); logfile.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD; logfile.EventRecordCallback = receiveEtw; logfile.Context = &context;
        consumer = OpenTraceW(&logfile); if (consumer == INVALID_PROCESSTRACE_HANDLE) throw WinError("trace-open");
        reader = std::thread([&] { readerCode = ProcessTrace(&consumer, 1, nullptr, nullptr); });
        EVENT_FILTER_EVENT_ID ids = {}; ids.FilterIn = TRUE; ids.Count = 1; ids.Events[0] = 1001;
        EVENT_FILTER_DESCRIPTOR descriptor = {}; descriptor.Ptr = reinterpret_cast<ULONGLONG>(&ids); descriptor.Size = sizeof(ids); descriptor.Type = EVENT_FILTER_TYPE_EVENT_ID;
        ENABLE_TRACE_PARAMETERS parameters = {}; parameters.Version = ENABLE_TRACE_PARAMETERS_VERSION_2; parameters.EnableFilterDesc = &descriptor; parameters.FilterDescCount = 1;
        code = EnableTraceEx2(session, &provider, EVENT_CONTROL_CODE_ENABLE_PROVIDER, TRACE_LEVEL_INFORMATION, 0x10000000000ULL, 0, 1000, &parameters); if (code) throw WinError("trace-enable", code); enabled = true;
        TraceProperties actual(run.id); code = ControlTraceW(session, nullptr, &actual.value, EVENT_TRACE_CONTROL_QUERY); if (code) throw WinError("trace-properties", code);
        log.line("{\"kind\":\"ready\",\"appIdHex\":\"" + hex(app.value->data, app.value->size) + "\",\"endpointAppIdHex\":\"" + context.canonicalOwnerId + "\",\"bufferKiB\":" + std::to_string(actual.value.BufferSize) + ",\"buffers\":" + std::to_string(actual.value.NumberOfBuffers) + ",\"maximumBuffers\":" + std::to_string(actual.value.MaximumBuffers) + "}");
        { Writer ready(run.output + L"\\ready.json"); ready.line("{\"ready\":true}"); }
        if (scenario == L"selftest-crash") TerminateProcess(GetCurrentProcess(), 123);
        const auto deadline = GetTickCount64() + 45000; bool requested = scenario == L"selftest-stop";
        auto drain = [&] { std::deque<Event> events; { std::lock_guard<std::mutex> lock(context.mutex); events.swap(context.pending); } for (auto& item : events) log.line(item.record + ",\"filter\":" + filter(engine.value, item.filterId) + "}"); };
        while (!requested && !context.failed && GetTickCount64() < deadline) {
            drain(); requested = exists(run.root + L"\\stop-etw.request");
            if (WaitForSingleObject(owner.value, 25) != WAIT_TIMEOUT || WaitForSingleObject(guardian.value, 0) != WAIT_TIMEOUT) break;
        }
        code = EnableTraceEx2(session, &provider, EVENT_CONTROL_CODE_DISABLE_PROVIDER, 0, 0, 0, 1000, nullptr); if (code) throw WinError("trace-disable", code); enabled = false;
        code = ControlTraceW(session, nullptr, &stopped.value, EVENT_TRACE_CONTROL_STOP); if (code) throw WinError("trace-stop", code); started = false;
        reader.join(); CloseTrace(consumer); consumer = INVALID_PROCESSTRACE_HANDLE; drain();
        if (readerCode != ERROR_SUCCESS) throw WinError("trace-consume", readerCode);
        const auto afterCollect = option(engine.value, FWPM_ENGINE_COLLECT_NET_EVENTS), afterKeywords = option(engine.value, FWPM_ENGINE_NET_EVENT_MATCH_ANY_KEYWORDS);
        const bool stable = beforeCollect == afterCollect && beforeKeywords == afterKeywords;
        code = FwpmEngineClose0(engine.value); if (code) throw WinError("engine-close", code); engine.value = nullptr;
        const bool noLoss = !context.failed && stopped.value.EventsLost == 0 && stopped.value.RealTimeBuffersLost == 0 && stopped.value.LogBuffersLost == 0;
        const bool countsMatch = context.providerMismatch + context.otherEventId + context.emptyAppId + context.otherAppId + context.otherEndpoint + context.matched == context.received && context.ntMatches + context.dosMatches == context.matched;
        const bool complete = requested && stable && noLoss && countsMatch && absent(run);
        log.line("{\"kind\":\"finished\",\"complete\":" + std::string(complete ? "true" : "false") + ",\"providerDisabled\":true,\"sessionStopped\":true,\"sessionAbsent\":true,\"consumerStopped\":true,\"engineClosed\":true,\"optionsUnchanged\":" + (stable ? "true" : "false") + ",\"collectAfter\":" + std::to_string(afterCollect) + ",\"keywordsAfter\":\"" + std::to_string(afterKeywords) + "\",\"eventsLost\":" + std::to_string(stopped.value.EventsLost) + ",\"realTimeBuffersLost\":" + std::to_string(stopped.value.RealTimeBuffersLost) + ",\"logBuffersLost\":" + std::to_string(stopped.value.LogBuffersLost) + ",\"callbackFailed\":" + (context.failed ? "true" : "false") + ",\"callbackStage\":" + json(std::wstring(context.failureStage.begin(), context.failureStage.end())) + ",\"callbackCode\":" + std::to_string(context.failureCode) + ",\"callbackVersion\":" + std::to_string(context.failureVersion) + ",\"failureRecorded\":" + (context.failureRecorded ? "true" : "false") + ",\"ownedFailurePayloadHex\":\"" + context.failurePayload + "\",\"received\":" + std::to_string(context.received.load()) + ",\"providerMismatch\":" + std::to_string(context.providerMismatch) + ",\"otherEventId\":" + std::to_string(context.otherEventId) + ",\"emptyAppId\":" + std::to_string(context.emptyAppId) + ",\"otherAppId\":" + std::to_string(context.otherAppId) + ",\"otherEndpoint\":" + std::to_string(context.otherEndpoint) + ",\"ntMatches\":" + std::to_string(context.ntMatches) + ",\"dosMatches\":" + std::to_string(context.dosMatches) + ",\"matchedEvents\":" + std::to_string(context.matched) + "}");
        result = complete ? 0 : 2;
    } catch (const WinError& error) { try { log.line("{\"kind\":\"error\",\"stage\":" + json(std::wstring(error.what(), error.what()+strlen(error.what()))) + ",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {} }
      catch (...) { try { log.line("{\"kind\":\"error\",\"stage\":\"unexpected\"}"); } catch (...) {} }
    if (enabled) EnableTraceEx2(session, &provider, EVENT_CONTROL_CODE_DISABLE_PROVIDER, 0, 0, 0, 1000, nullptr);
    if (started) ControlTraceW(session, nullptr, &stopped.value, EVENT_TRACE_CONTROL_STOP);
    if (consumer != INVALID_PROCESSTRACE_HANDLE) CloseTrace(consumer);
    if (reader.joinable()) reader.join();
    { Writer stop(run.output + L"\\guard-stop.request"); stop.line("STOP"); }
    if (WaitForSingleObject(guardian.value, 10000) != WAIT_OBJECT_0) result = 1;
    DWORD guardCode = 1; if (!GetExitCodeProcess(guardian.value, &guardCode) || guardCode != 0 || !absent(run)) result = 1;
    Writer done(run.output + L"\\done.json"); done.line("{\"exitCode\":" + std::to_string(result) + ",\"guardExitCode\":" + std::to_string(guardCode) + "}");
    return result;
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"selftest-endpoints") { checkEndpoints(); return 0; }
        if (argc != 4 && argc != 5 && argc != 6) return 64; const Run run(argv[1]); const auto pid = boundedNumber(argv[2], MAXDWORD); const std::wstring mode(argv[3]);
        if (mode == L"guard") return guard(run, pid);
        if (mode != L"observe" && mode != L"selftest-stop" && mode != L"selftest-crash") return 64;
        std::array<unsigned short, 4> ports = {};
        if (mode == L"observe") {
            if (argc != 6) return 64; const std::wstring values(argv[4]); size_t offset = 0;
            for (size_t i = 0; i < ports.size(); ++i) {
                const auto end = values.find(L',', offset);
                if ((i < 3) != (end != std::wstring::npos)) return 64;
                const auto part = values.substr(offset, end == std::wstring::npos ? end : end-offset);
                ports[i] = static_cast<unsigned short>(boundedNumber(part.c_str(), 65535)); if (!ports[i]) return 64;
                offset = end == std::wstring::npos ? values.size() : end+1;
            }
        }
        return observe(run, pid, mode, ports, argc == 6 ? argv[5] : L"");
    } catch (...) { return 1; }
}
