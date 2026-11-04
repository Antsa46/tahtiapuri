#include "observation-support.h"

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
