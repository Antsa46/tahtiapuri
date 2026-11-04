#include "common.h"

// Fixed, primary-only reads of owned resources. No child or Winsock calls.
static void openImage(const std::wstring& path, const char* name, DWORD mask) {
    Handle file(CreateFileW(path.c_str(), mask, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    const bool ok = file.value != INVALID_HANDLE_VALUE; const DWORD code = ok ? 0 : GetLastError();
    emit("{\"type\":\"resource-open\",\"name\":\"" + std::string(name) + "\",\"mask\":" + std::to_string(mask) + ",\"disposition\":3,\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + "}");
}
static void defaultDacl() {
    HANDLE raw = nullptr; const BOOL opened = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw);
    const DWORD openCode = opened ? 0 : GetLastError(); Handle token(raw);
    DWORD needed = 0, returned = 0, code = openCode, sizingCode = 0;
    std::vector<BYTE> bytes; bool ok = false, nullDacl = false; DWORD aceCount = 0, aclBytes = 0; std::string sddl;
    if (opened) {
        const BOOL sized = GetTokenInformation(token.value, TokenDefaultDacl, nullptr, 0, &needed);
        sizingCode = sized ? 0 : GetLastError();
        if (!sized && sizingCode != ERROR_INSUFFICIENT_BUFFER) { code = sizingCode; }
        else {
        if (sized || needed < sizeof(TOKEN_DEFAULT_DACL) || needed > 65536) throw WinError("resource-dacl-size", ERROR_INVALID_DATA);
        bytes.resize(needed);
        ok = GetTokenInformation(token.value, TokenDefaultDacl, bytes.data(), needed, &returned) != FALSE;
        code = ok ? 0 : GetLastError();
        if (ok) {
            if (returned < sizeof(TOKEN_DEFAULT_DACL) || returned > needed) throw WinError("resource-dacl-returned", ERROR_INVALID_DATA);
            const PACL acl = reinterpret_cast<TOKEN_DEFAULT_DACL*>(bytes.data())->DefaultDacl;
            nullDacl = acl == nullptr;
            if (acl) {
                const auto start = reinterpret_cast<ULONG_PTR>(bytes.data()), address = reinterpret_cast<ULONG_PTR>(acl);
                if (address < start || address - start > returned - sizeof(ACL)) throw WinError("resource-dacl-pointer", ERROR_INVALID_DATA);
                if (acl->AclSize > returned - (address - start) || !IsValidAcl(acl) || acl->AceCount > 128) throw WinError("resource-dacl-bounds", ERROR_INVALID_ACL);
                aceCount = acl->AceCount; aclBytes = acl->AclSize;
            }
            // This descriptor is only a local serialization buffer, never applied.
            SECURITY_DESCRIPTOR descriptor = {};
            if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) || !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE)) throw WinError("resource-dacl-descriptor");
            LPWSTR text = nullptr; ULONG length = 0;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(&descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, &length)) throw WinError("resource-dacl-string");
            try { if (length > 16384) throw WinError("resource-dacl-string-limit", ERROR_INVALID_DATA); sddl = ascii(text); }
            catch (...) { LocalFree(text); throw; }
            LocalFree(text);
        }
        }
    }
    emit("{\"type\":\"resource-dacl\",\"api\":\"GetTokenInformation\",\"infoClass\":" + std::to_string(static_cast<int>(TokenDefaultDacl)) + ",\"tokenAccess\":8,\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + ",\"openCode\":" + std::to_string(openCode) + ",\"sizingCode\":" + std::to_string(sizingCode) + ",\"neededBytes\":" + std::to_string(needed) + ",\"returnedBytes\":" + std::to_string(returned) + ",\"nullDacl\":" + (ok ? (nullDacl ? "true" : "false") : "null") + ",\"aceCount\":" + (ok ? std::to_string(aceCount) : "null") + ",\"aclBytes\":" + (ok ? std::to_string(aclBytes) : "null") + ",\"sddl\":" + (ok ? "\"" + sddl + "\"" : "null") + "}");
}
static void childPolicy() {
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy = {};
    const BOOL ok = GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy, &policy, sizeof(policy));
    const DWORD code = ok ? 0 : GetLastError();
    emit("{\"type\":\"resource-policy\",\"api\":\"GetProcessMitigationPolicy\",\"policy\":\"ProcessChildProcessPolicy\",\"bufferBytes\":" + std::to_string(sizeof(policy)) + ",\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + std::to_string(code) + ",\"flags\":" + (ok ? std::to_string(policy.Flags) : "null") + ",\"noChildProcessCreation\":" + (ok ? (policy.NoChildProcessCreation ? "true" : "false") : "null") + "}");
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 10 || std::wstring(argv[7]) != L"resource-once" || std::wstring(argv[9]) != L"primary") throw WinError("resource-arguments", ERROR_INVALID_PARAMETER);
        const std::wstring root(argv[1]); const auto token = inspectToken(GetCurrentProcess()); BOOL job = FALSE;
        if (!IsProcessInJob(GetCurrentProcess(), nullptr, &job)) throw WinError("resource-job");
        emit("{\"type\":\"token\",\"phase\":\"primary\",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"job\":" + (job ? "true" : "false") + ",\"appContainer\":" + (token.app ? "true" : "false") + ",\"lpac\":" + jsonFlag(token.lpac) + ",\"lpacQueryError\":" + std::to_string(token.lpacQueryError) + ",\"lpacQueryBytes\":" + std::to_string(token.lpacQueryBytes) + ",\"capabilities\":" + std::to_string(token.capabilities) + ",\"integrity\":" + std::to_string(token.integrity) + ",\"sid\":\"" + ascii(token.sid) + "\"}");
        openImage(root + L"\\package\\probe.exe", "self-read", FILE_READ_DATA);
        openImage(root + L"\\package\\probe.exe", "self-execute", FILE_EXECUTE);
        openImage(root + L"\\package\\allowed.txt", "allowed", FILE_READ_DATA);
        openImage(root + L"\\package\\legacy.fixture", "aap", FILE_READ_DATA);
        openImage(root + L"\\private\\secret.txt", "outside", FILE_READ_DATA);
        defaultDacl(); childPolicy();
        emit("{\"type\":\"resource-complete\",\"phase\":\"primary\",\"observations\":7}"); return 0;
    } catch (const WinError& error) { try { emit("{\"type\":\"probe-error\",\"stage\":\"" + std::string(error.what()) + "\",\"code\":" + std::to_string(error.code) + "}"); } catch (...) {} }
    return 1;
}
