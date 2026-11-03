#include "common.h"
#include <memory>

static bool ownedProfile(const std::wstring& name) {
    for (const std::wstring prefix : { L"tahtiapuri.t09a.", L"tahtiapuri.t09b.", L"tahtiapuri.t09c." }) {
        if (name.size() == prefix.size() + 32 && name.compare(0, prefix.size(), prefix) == 0)
            return std::all_of(name.begin() + prefix.size(), name.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
    }
    return false;
}
static std::wstring filePath(const std::wstring& path) { return path.size() > 2 && path[1] == L':' ? L"\\\\?\\" + path : path; }
static void regular(const std::wstring& path, bool directory) {
    const auto actualPath = filePath(path);
    DWORD attrs = GetFileAttributesW(actualPath.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) || ((attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) throw WinError("resource-type", ERROR_INVALID_DATA);
    if (!directory) {
        Handle file(CreateFileW(actualPath.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        BY_HANDLE_FILE_INFORMATION info = {};
        if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &info) || info.nNumberOfLinks != 1) throw WinError("resource-link", ERROR_INVALID_DATA);
    }
}
static std::wstring ownedRoot(const std::wstring& input) {
    if (input.size() > 1024 || input.size() < 4 || input[1] != L':' || input[2] != L'\\' || input.find(L"..") != std::wstring::npos) throw WinError("root", ERROR_INVALID_PARAMETER);
    DWORD length = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr); std::vector<wchar_t> full(length + 1);
    if (!length || !GetFullPathNameW(input.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr)) throw WinError("root");
    std::wstring root(full.data());
    for (size_t at = 3; at <= root.size(); ++at) if (at == root.size() || root[at] == L'\\') regular(root.substr(0, at), true);
    regular(root + L"\\owner.marker", false);
    Handle marker(CreateFileW((root + L"\\owner.marker").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
    char value[64] = {}; DWORD read = 0;
    if (marker.value == INVALID_HANDLE_VALUE || !ReadFile(marker.value, value, 63, &read, nullptr) || std::string(value, read) != "TAHTIAPURI_T09A_SYNTHETIC_ONLY") throw WinError("marker", ERROR_INVALID_DATA);
    return root;
}

static void receipt(const std::wstring& root, const std::wstring& profile, bool create) {
    const auto value = ascii(profile); const auto path = root + L"\\profile.receipt";
    Handle file(CreateFileW(path.c_str(), create ? GENERIC_WRITE : GENERIC_READ, FILE_SHARE_READ, nullptr, create ? CREATE_NEW : OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) throw WinError("profile-receipt");
    if (create) { DWORD written = 0; if (!WriteFile(file.value, value.data(), static_cast<DWORD>(value.size()), &written, nullptr) || written != static_cast<DWORD>(value.size())) throw WinError("receipt-write"); }
    else { regular(path, false); char text[128] = {}; DWORD bytes = 0; if (!ReadFile(file.value, text, sizeof(text), &bytes, nullptr) || std::string(text, bytes) != value) throw WinError("receipt-owner", ERROR_ACCESS_DENIED); }
}
static bool sentinelInherited(HANDLE child, HANDLE sentinel) {
    HANDLE raw = nullptr;
    if (!DuplicateHandle(child, sentinel, GetCurrentProcess(), &raw, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        const DWORD error = GetLastError(); if (error == ERROR_INVALID_HANDLE) return false;
        throw WinError("sentinel-duplicate", error);
    }
    Handle copy(raw); BY_HANDLE_FILE_INFORMATION expected = {}, actual = {};
    if (!GetFileInformationByHandle(sentinel, &expected)) throw WinError("sentinel-original");
    const DWORD type = GetFileType(copy.value);
    if (type == FILE_TYPE_PIPE || type == FILE_TYPE_CHAR) return false;
    if (type != FILE_TYPE_DISK) throw WinError("sentinel-file-type", ERROR_INVALID_DATA);
    if (!GetFileInformationByHandle(copy.value, &actual)) throw WinError("sentinel-metadata");
    return actual.dwVolumeSerialNumber == expected.dwVolumeSerialNumber && actual.nFileIndexHigh == expected.nFileIndexHigh && actual.nFileIndexLow == expected.nFileIndexLow;
}
static bool stopJob(HANDLE job) {
    if (!TerminateJobObject(job, 42)) return false;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
    for (int n = 0; n < 250; ++n) {
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) return false;
        if (info.ActiveProcesses == 0) return true;
        Sleep(20);
    }
    return false;
}

static void setOwnedAcl(const std::wstring& path, PSID package, DWORD access, bool inherit) {
    const auto actualPath = filePath(path);
    HANDLE raw = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) throw WinError("acl-token"); Handle token(raw);
    auto user = tokenInfo(token.value, TokenUser); PSID owner = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    PSID system = nullptr; if (!ConvertStringSidToSidW(L"S-1-5-18", &system)) throw WinError("system-sid");
    EXPLICIT_ACCESSW rules[3] = {}; const DWORD count = package ? 3 : 2;
    for (DWORD i = 0; i < count; ++i) {
        rules[i].grfAccessMode = SET_ACCESS; rules[i].grfInheritance = inherit ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
        rules[i].Trustee.TrusteeForm = TRUSTEE_IS_SID; rules[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    }
    rules[0].grfAccessPermissions = FILE_ALL_ACCESS; rules[0].Trustee.ptstrName = reinterpret_cast<LPWSTR>(owner);
    rules[1].grfAccessPermissions = FILE_ALL_ACCESS; rules[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(system);
    if (package) { rules[2].grfAccessPermissions = access; rules[2].Trustee.ptstrName = reinterpret_cast<LPWSTR>(package); }
    PACL acl = nullptr; DWORD result = SetEntriesInAclW(count, rules, nullptr, &acl);
    if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(actualPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
    if (result == ERROR_SUCCESS) {
        PSECURITY_DESCRIPTOR actual = nullptr; PACL readback = nullptr;
        result = GetNamedSecurityInfoW(const_cast<LPWSTR>(actualPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &readback, nullptr, &actual);
        if (result == ERROR_SUCCESS) {
            SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
            bool valid = GetSecurityDescriptorControl(actual, &control, &revision) && (control & SE_DACL_PROTECTED) && readback && readback->AceCount == count;
            bool seen[3] = {};
            for (DWORD n = 0; valid && n < count; ++n) {
                void* entry = nullptr; valid = GetAce(readback, n, &entry) != FALSE;
                if (!valid) break;
                const auto ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(entry);
                valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == (inherit ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0);
                bool found = false;
                for (DWORD i = 0; valid && i < count; ++i) if (!seen[i] && EqualSid(&ace->SidStart, rules[i].Trustee.ptstrName) && ace->Mask == rules[i].grfAccessPermissions) { seen[i] = true; found = true; break; }
                valid = valid && found;
            }
            if (!valid) result = ERROR_INVALID_ACL;
        }
        if (actual) LocalFree(actual);
    }
    if (acl) LocalFree(acl);
    LocalFree(system);
    if (result != ERROR_SUCCESS) throw WinError("set-owned-acl", result);
}
static void lowScratch(const std::wstring& path) {
    const auto actualPath = filePath(path);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &descriptor, nullptr)) throw WinError("low-descriptor");
    BOOL present = FALSE, defaulted = FALSE; PACL sacl = nullptr;
    GetSecurityDescriptorSacl(descriptor, &present, &sacl, &defaulted);
    DWORD result = present ? SetNamedSecurityInfoW(const_cast<LPWSTR>(actualPath.c_str()), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, sacl) : ERROR_INVALID_DATA;
    LocalFree(descriptor); if (result != ERROR_SUCCESS) throw WinError("low-scratch", result);
}
static void prepareResources(const std::wstring& root, PSID sid) {
    for (const auto& dir : { L"package", L"private", L"scratch" }) regular(root + L"\\" + dir, true);
    for (const auto& file : { L"package\\probe.exe", L"package\\allowed.txt", L"package\\weights.fixture", L"package\\legacy.fixture", L"package\\module.mjs", L"private\\secret.txt" }) regular(root + L"\\" + file, false);
    setOwnedAcl(root, sid, FILE_TRAVERSE, true);
    setOwnedAcl(root + L"\\owner.marker", nullptr, 0, false);
    if (GetFileAttributesW((root + L"\\profile.receipt").c_str()) != INVALID_FILE_ATTRIBUTES) setOwnedAcl(root + L"\\profile.receipt", nullptr, 0, false);
    regular(root + L"\\launcher", true); regular(root + L"\\launcher\\host.exe", false);
    setOwnedAcl(root + L"\\launcher", nullptr, 0, true);
    setOwnedAcl(root + L"\\launcher\\host.exe", nullptr, 0, false);
    setOwnedAcl(root + L"\\private", nullptr, 0, true);
    setOwnedAcl(root + L"\\private\\secret.txt", nullptr, 0, false);
    const DWORD read = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    setOwnedAcl(root + L"\\package", sid, read, true);
    for (const auto& name : { L"probe.exe", L"allowed.txt", L"weights.fixture", L"module.mjs" }) setOwnedAcl(root + L"\\package\\" + name, sid, read, false);
    PSID legacy = nullptr; if (!ConvertStringSidToSidW(L"S-1-15-2-1", &legacy)) throw WinError("aap-sid");
    try { setOwnedAcl(root + L"\\package\\legacy.fixture", legacy, read, false); } catch (...) { LocalFree(legacy); throw; }
    LocalFree(legacy);
    setOwnedAcl(root + L"\\scratch", sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD, true);
    lowScratch(root + L"\\scratch");
}
static void readOnlyTree(const std::wstring& path, PSID sid, unsigned& remaining, bool apply) {
    if (remaining-- == 0) throw WinError("package-entry-limit", ERROR_INVALID_DATA);
    const DWORD attributes = GetFileAttributesW(filePath(path).c_str());
    const bool directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    regular(path, directory);
    if (apply) setOwnedAcl(path, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, directory);
    if (!directory) return;
    WIN32_FIND_DATAW data = {}; HANDLE search = FindFirstFileW(filePath(path + L"\\*").c_str(), &data);
    if (search == INVALID_HANDLE_VALUE) throw WinError("package-enumerate");
    try {
        do {
            if (std::wstring(data.cFileName) == L"." || std::wstring(data.cFileName) == L"..") continue;
            readOnlyTree(path + L"\\" + data.cFileName, sid, remaining, apply);
        } while (FindNextFileW(search, &data));
        if (GetLastError() != ERROR_NO_MORE_FILES) throw WinError("package-next");
    } catch (...) { FindClose(search); throw; }
    FindClose(search);
}
static void prepareElectronResources(const std::wstring& root, PSID sid, bool sdk) {
    for (const auto& dir : { L"package", L"private", L"scratch", L"launcher" }) regular(root + L"\\" + dir, true);
    for (const auto& name : { L"package\\electron.exe", L"package\\allowed.txt", L"package\\module.mjs", L"private\\secret.txt", L"launcher\\host.exe" }) regular(root + L"\\" + name, false);
    regular(root + (sdk ? L"\\package\\sdk-probe.mjs" : L"\\package\\runtime-probe.mjs"), false);
    unsigned verified = sdk ? 25000 : 2000; readOnlyTree(root, sid, verified, false);
    setOwnedAcl(root, sid, FILE_TRAVERSE, true);
    for (const auto& name : { L"owner.marker", L"profile.receipt" }) if (GetFileAttributesW((root + L"\\" + name).c_str()) != INVALID_FILE_ATTRIBUTES) setOwnedAcl(root + L"\\" + name, nullptr, 0, false);
    setOwnedAcl(root + L"\\launcher", nullptr, 0, true);
    setOwnedAcl(root + L"\\launcher\\host.exe", nullptr, 0, false);
    setOwnedAcl(root + L"\\private", nullptr, 0, true);
    setOwnedAcl(root + L"\\private\\secret.txt", nullptr, 0, false);
    unsigned remaining = sdk ? 25000 : 2000; readOnlyTree(root + L"\\package", sid, remaining, true);
    setOwnedAcl(root + L"\\scratch", sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD, true);
    lowScratch(root + L"\\scratch");
}
static std::wstring environment(const std::wstring& root, bool electron, bool sdk) {
    wchar_t windows[MAX_PATH] = {}; if (!GetWindowsDirectoryW(windows, MAX_PATH)) throw WinError("windows-directory");
    std::vector<std::wstring> entries = { L"APPDATA=" + root + L"\\scratch", L"LOCALAPPDATA=" + root + L"\\scratch", L"PATH=" + std::wstring(windows) + L"\\System32", L"SystemRoot=" + std::wstring(windows), L"TEMP=" + root + L"\\scratch", L"TMP=" + root + L"\\scratch", L"USERPROFILE=" + root + L"\\scratch", L"WINDIR=" + std::wstring(windows) };
    if (electron) entries.push_back(L"ELECTRON_RUN_AS_NODE=1");
    if (sdk) entries.push_back(L"NODE_LLAMA_CPP_SKIP_DOWNLOAD=true");
    std::sort(entries.begin(), entries.end()); std::wstring block;
    for (const auto& entry : entries) { block += entry; block += L'\0'; } block += L'\0'; return block;
}
struct AttributeList {
    std::vector<BYTE> storage; LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    explicit AttributeList(DWORD count) {
        SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, count, 0, &bytes); storage.resize(bytes);
        list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(list, count, 0, &bytes)) throw WinError("attribute-init");
    }
    ~AttributeList() { if (list) DeleteProcThreadAttributeList(list); }
    void put(DWORD_PTR key, void* value, SIZE_T bytes) { if (!UpdateProcThreadAttribute(list, 0, key, value, bytes, nullptr, nullptr)) throw WinError("attribute-put"); }
};
static std::string base64(const std::string& bytes) {
    const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    for (size_t at = 0; at < bytes.size(); at += 3) {
        const unsigned a = static_cast<unsigned char>(bytes[at]);
        const unsigned b = at + 1 < bytes.size() ? static_cast<unsigned char>(bytes[at + 1]) : 0;
        const unsigned c = at + 2 < bytes.size() ? static_cast<unsigned char>(bytes[at + 2]) : 0;
        result += alphabet[a >> 2]; result += alphabet[((a & 3) << 4) | (b >> 4)];
        result += at + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
        result += at + 2 < bytes.size() ? alphabet[c & 63] : '=';
    }
    return result;
}
static void relayWorker(HANDLE input, std::string& pending, size_t& total, bool final) {
    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) throw WinError("worker-output-peek");
            break;
        }
        if (available == 0) break;
        char buffer[4096] = {}; DWORD bytes = 0;
        if (!ReadFile(input, buffer, std::min<DWORD>(available, sizeof(buffer)), &bytes, nullptr)) throw WinError("worker-output-read");
        total += bytes; if (total > 128 * 1024) throw WinError("worker-output-budget", ERROR_INVALID_DATA);
        pending.append(buffer, bytes);
        size_t newline = 0;
        while ((newline = pending.find('\n')) != std::string::npos) {
            const auto line = pending.substr(0, newline); pending.erase(0, newline + 1);
            emit("{\"type\":\"worker-output\",\"data\":\"" + base64(line) + "\"}");
        }
        if (pending.size() > 65536) throw WinError("worker-line-budget", ERROR_INVALID_DATA);
    }
    if (final && !pending.empty()) throw WinError("worker-unterminated-output", ERROR_INVALID_DATA);
}
static void inspectSdkChild(HANDLE job, DWORD parent, DWORD& observed, const std::wstring& root, const std::wstring& nonce, const TokenView& primary, HANDLE ack) {
    std::vector<BYTE> storage(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 7);
    auto members = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, members, static_cast<DWORD>(storage.size()), nullptr)) throw WinError("sdk-job-members");
    if (members->NumberOfAssignedProcesses > 2 || members->NumberOfProcessIdsInList > 2) throw WinError("sdk-child-count", ERROR_INVALID_DATA);
    for (DWORD n = 0; n < members->NumberOfProcessIdsInList; ++n) {
        const ULONG_PTR raw = members->ProcessIdList[n]; if (raw > MAXDWORD) throw WinError("sdk-child-id", ERROR_INVALID_DATA);
        const DWORD pid = static_cast<DWORD>(raw); if (pid == parent || pid == observed) continue;
        if (observed != 0) throw WinError("sdk-multiple-children", ERROR_INVALID_DATA);
        Handle child(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        if (!child.value) throw WinError("sdk-open-child");
        BOOL member = FALSE;
        if (!IsProcessInJob(child.value, job, &member) || !member || WaitForSingleObject(child.value, 0) != WAIT_TIMEOUT) throw WinError("sdk-child-job", ERROR_ACCESS_DENIED);
        wchar_t image[2048] = {}; DWORD length = 2048;
        if (!QueryFullProcessImageNameW(child.value, 0, image, &length) || _wcsicmp(image, (root + L"\\package\\electron.exe").c_str()) != 0) throw WinError("sdk-child-image", ERROR_ACCESS_DENIED);
        const auto token = inspectToken(child.value);
        if (token.app != primary.app || token.sid != primary.sid || token.capabilities != 0 || token.integrity != primary.integrity || token.lpac != primary.lpac || token.lpacQueryError != primary.lpacQueryError) throw WinError("sdk-child-token", ERROR_ACCESS_DENIED);
        emit("{\"type\":\"inspected-child\",\"pid\":" + std::to_string(pid) + ",\"job\":true,\"imageVerified\":true,\"appContainer\":" + (token.app ? "true" : "false") + ",\"sid\":\"" + ascii(token.sid) + "\",\"capabilities\":" + std::to_string(token.capabilities) + ",\"integrity\":" + std::to_string(token.integrity) + ",\"lpac\":" + jsonFlag(token.lpac) + "}");
        const std::string message = "{\"type\":\"sdk-child-ack\",\"nonce\":\"" + ascii(nonce) + "\",\"pid\":" + std::to_string(pid) + "}\n";
        DWORD written = 0; if (!WriteFile(ack, message.data(), static_cast<DWORD>(message.size()), &written, nullptr) || written != static_cast<DWORD>(message.size())) throw WinError("sdk-child-ack");
        observed = pid;
    }
}
int wmain(int argc, wchar_t** argv) {
    PSID sid = nullptr; std::wstring profile; bool created = false; int result = 1; Handle job;
    try {
        if (argc == 4 && std::wstring(argv[1]) == L"cleanup" && ownedProfile(argv[2])) {
            receipt(ownedRoot(argv[3]), argv[2], false);
            const HRESULT hr = DeleteAppContainerProfile(argv[2]); emit("{\"type\":\"cleanup\",\"hresult\":" + std::to_string(hr) + "}"); return FAILED(hr) ? 1 : 0;
        }
        if (argc == 4 && std::wstring(argv[1]) == L"stop-owned") {
            const std::wstring root = ownedRoot(argv[2]); const DWORD pid = boundedNumber(argv[3], MAXDWORD);
            Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid));
            if (!process.value && GetLastError() == ERROR_INVALID_PARAMETER) return 0;
            if (!process.value) throw WinError("emergency-open");
            wchar_t image[2048] = {}; DWORD length = 2048;
            if (!QueryFullProcessImageNameW(process.value, 0, image, &length)) throw WinError("emergency-image");
            if (_wcsicmp(image, (root + L"\\package\\electron.exe").c_str()) != 0 && _wcsicmp(image, (root + L"\\package\\probe.exe").c_str()) != 0 && _wcsicmp(image, (root + L"\\launcher\\host.exe").c_str()) != 0) throw WinError("emergency-identity", ERROR_ACCESS_DENIED);
            if (!TerminateProcess(process.value, 44) || WaitForSingleObject(process.value, 5000) != WAIT_OBJECT_0) throw WinError("emergency-stop");
            emit("{\"type\":\"emergency-stopped\"}"); return 0;
        }
        if (argc != 11 || (std::wstring(argv[1]) != L"run" && std::wstring(argv[1]) != L"run-electron" && std::wstring(argv[1]) != L"run-sdk")) throw WinError("arguments", ERROR_INVALID_PARAMETER);
        const bool sdk = std::wstring(argv[1]) == L"run-sdk";
        const bool electron = sdk || std::wstring(argv[1]) == L"run-electron";
        std::wstring mode(argv[2]); profile = argv[3]; const std::wstring root = ownedRoot(argv[4]);
        if ((mode != L"control" && mode != L"control-inherit" && mode != L"ac" && mode != L"lpac") || !ownedProfile(profile)) throw WinError("profile-arguments", ERROR_INVALID_PARAMETER);
        const std::wstring purpose = sdk ? L"tahtiapuri.t09c." : electron ? L"tahtiapuri.t09b." : L"tahtiapuri.t09a.";
        if (sdk && mode != L"control" && mode != L"ac") throw WinError("sdk-policy", ERROR_INVALID_PARAMETER);
        if (profile.compare(0, purpose.size(), purpose) != 0) throw WinError("profile-purpose", ERROR_INVALID_PARAMETER);
        for (int n = 5; n <= 9; ++n) if (boundedNumber(argv[n], 65535) == 0) throw WinError("port", ERROR_INVALID_PARAMETER);
        const std::wstring life(argv[10]);
        const bool primaryOnly = life == L"primary-once" || life == L"primary-hold" || life == L"primary-fail";
        if (life != L"once" && life != L"hold" && life != L"fail" && !(sdk && life == L"missing-binary") && !(primaryOnly && mode == L"lpac")) throw WinError("lifetime", ERROR_INVALID_PARAMETER);
        const std::wstring childLife = primaryOnly ? life.substr(8) : life;
        if (mode == L"ac" || mode == L"lpac") {
            const HRESULT hr = CreateAppContainerProfile(profile.c_str(), L"Tahtiapuri synthetic isolation probe", L"Temporary owned test profile", nullptr, 0, &sid);
            if (FAILED(hr)) throw WinError("create-profile", static_cast<DWORD>(hr));
            created = true;
            receipt(root, profile, true);
            LPWSTR text = nullptr; if (!ConvertSidToStringSidW(sid, &text)) throw WinError("profile-sid");
            emit("{\"type\":\"profile\",\"name\":\"" + ascii(profile) + "\",\"sid\":\"" + ascii(text) + "\"}"); LocalFree(text);
        }
        if (electron) prepareElectronResources(root, sid, sdk); else prepareResources(root, sid);
        job.value = CreateJobObjectW(nullptr, nullptr); if (!job.value) throw WinError("job");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw WinError("job-limits");
        Handle input, ack, workerRead, workerWrite;
        if (sdk) {
            SECURITY_ATTRIBUTES pipeAttributes = { sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
            if (!CreatePipe(&input.value, &ack.value, &pipeAttributes, 4096) || !SetHandleInformation(ack.value, HANDLE_FLAG_INHERIT, 0)) throw WinError("sdk-input-pipe");
            if (!CreatePipe(&workerRead.value, &workerWrite.value, &pipeAttributes, 4096) || !SetHandleInformation(workerRead.value, HANDLE_FLAG_INHERIT, 0)) throw WinError("sdk-output-pipe");
        } else input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        HANDLE inherited[4] = { input.value, sdk ? workerWrite.value : GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE), nullptr };
        for (int i = 0; i < 3; ++i) { const HANDLE handle = inherited[i]; if (!handle || handle == INVALID_HANDLE_VALUE || !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw WinError("inheritable-stdio"); }
        Handle sentinel(CreateFileW((root + L"\\private\\secret.txt").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
        if (sentinel.value == INVALID_HANDLE_VALUE || !SetHandleInformation(sentinel.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw WinError("sentinel");
        inherited[3] = sentinel.value;
        SECURITY_CAPABILITIES capabilities = {}; capabilities.AppContainerSid = sid; DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
        AttributeList attributes(mode == L"lpac" ? 4 : mode == L"ac" ? 3 : 2);
        attributes.put(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, (mode == L"control-inherit" ? 4 : 3) * sizeof(HANDLE));
        attributes.put(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value));
        if (sid) attributes.put(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
        if (mode == L"lpac") attributes.put(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy));
        STARTUPINFOEXW startup = {}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes.list;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1]; startup.StartupInfo.hStdError = inherited[2];
        const std::wstring image = root + (electron ? L"\\package\\electron.exe" : L"\\package\\probe.exe");
        std::wstring command = quote(image);
        if (electron) command += L" --preserve-symlinks --preserve-symlinks-main " + quote(root + (sdk ? L"\\package\\sdk-probe.mjs" : L"\\package\\runtime-probe.mjs"));
        command += L" " + quote(root);
        for (int n = 5; n <= 9; ++n) command += L" " + quote(argv[n]);
        command += L" " + quote(childLife) + L" " + std::to_wstring(reinterpret_cast<ULONG_PTR>(sentinel.value)) + (primaryOnly ? L" primary-only" : L" primary");
        std::wstring env = environment(root, electron, sdk); PROCESS_INFORMATION process = {};
        if (!CreateProcessW(image.c_str(), &command[0], nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, &env[0], (root + L"\\package").c_str(), &startup.StartupInfo, &process)) throw WinError("create-child");
        Handle child(process.hProcess), thread(process.hThread);
        if (sdk) { CloseHandle(workerWrite.value); workerWrite.value = nullptr; }
        BOOL inJob = FALSE; if (!IsProcessInJob(child.value, job.value, &inJob) || !inJob) throw WinError("job-membership");
        const auto view = inspectToken(child.value);
        const bool inheritedSentinel = sentinelInherited(child.value, sentinel.value);
        if (inheritedSentinel != (mode == L"control-inherit")) throw WinError("sentinel-inheritance", ERROR_ACCESS_DENIED);
        if (sid && (!view.app || view.capabilities != 0 || view.integrity != SECURITY_MANDATORY_LOW_RID || (view.lpac >= 0 && view.lpac != (mode == L"lpac" ? 1 : 0)) || (view.lpac < 0 && view.lpacQueryError != ERROR_INVALID_PARAMETER))) throw WinError("child-token", ERROR_ACCESS_DENIED);
        if (sid) { LPWSTR expected = nullptr; if (!ConvertSidToStringSidW(sid, &expected)) throw WinError("expected-sid"); bool same = view.sid == expected; LocalFree(expected); if (!same) throw WinError("child-identity", ERROR_ACCESS_DENIED); }
        emit("{\"type\":\"launched\",\"requestedPolicy\":\"" + ascii(mode) + "\",\"aclsVerified\":true,\"sentinelInherited\":" + std::string(inheritedSentinel ? "true" : "false") + ",\"pid\":" + std::to_string(process.dwProcessId) + ",\"job\":true,\"appContainer\":" + (view.app ? "true" : "false") + ",\"lpac\":" + jsonFlag(view.lpac) + ",\"lpacQueryError\":" + std::to_string(view.lpacQueryError) + ",\"lpacQueryBytes\":" + std::to_string(view.lpacQueryBytes) + ",\"capabilities\":" + std::to_string(view.capabilities) + ",\"integrity\":" + std::to_string(view.integrity) + "}");
        if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) throw WinError("resume");
        const ULONGLONG deadline = GetTickCount64() + (sdk ? 60000 : 30000); bool ownerGone = false; DWORD inspected = 0; std::string pendingOutput; size_t outputBytes = 0;
        for (;;) {
            if (WaitForSingleObject(child.value, 20) == WAIT_OBJECT_0) break;
            if (sdk) relayWorker(workerRead.value, pendingOutput, outputBytes, false);
            if (sdk) inspectSdkChild(job.value, process.dwProcessId, inspected, root, profile.substr(purpose.size()), view, ack.value);
            DWORD available = 0;
            if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) { ownerGone = true; break; }
            if (available > 0) { ownerGone = true; break; }
            if (GetTickCount64() >= deadline) throw WinError("child-deadline", WAIT_TIMEOUT);
        }
        if (ownerGone && !TerminateJobObject(job.value, 42)) throw WinError("owner-loss-job");
        if (WaitForSingleObject(child.value, 5000) != WAIT_OBJECT_0) throw WinError("child-exit", WAIT_TIMEOUT);
        if (sdk) relayWorker(workerRead.value, pendingOutput, outputBytes, true);
        DWORD exitCode = 1; if (!GetExitCodeProcess(child.value, &exitCode)) throw WinError("exit-code");
        if (!TerminateJobObject(job.value, exitCode)) throw WinError("final-job-stop");
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
        for (int n = 0; n < 100; ++n) {
            if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) throw WinError("job-accounting");
            if (accounting.ActiveProcesses == 0) break;
            Sleep(20);
        }
        if (accounting.ActiveProcesses != 0) throw WinError("descendants-alive", WAIT_TIMEOUT);
        emit("{\"type\":\"finished\",\"ownerGone\":" + std::string(ownerGone ? "true" : "false") + ",\"exitCode\":" + std::to_string(exitCode) + ",\"activeProcesses\":0}");
        result = ownerGone ? 0 : exitCode == 0 ? 0 : 1;
    } catch (const WinError& error) { try { emit("{\"type\":\"error\",\"stage\":\"" + std::string(error.what()) + "\",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {} }
      catch (...) { try { emit("{\"type\":\"error\",\"stage\":\"unexpected\"}"); } catch (...) {} }
    bool processesStopped = true;
    if (job.value) {
        processesStopped = stopJob(job.value); CloseHandle(job.value); job.value = nullptr;
        if (!processesStopped) { result = 1; try { emit("{\"type\":\"error\",\"stage\":\"error-path-job-cleanup\"}"); } catch (...) {} }
    }
    if (sid) FreeSid(sid);
    if (created && processesStopped) {
        HRESULT hr = E_FAIL; for (int n = 0; n < 20; ++n) { hr = DeleteAppContainerProfile(profile.c_str()); if (SUCCEEDED(hr)) break; Sleep(50); }
        try { emit("{\"type\":\"cleanup\",\"hresult\":" + std::to_string(hr) + "}"); } catch (...) {}
        if (FAILED(hr)) result = 1;
    }
    return result;
}
