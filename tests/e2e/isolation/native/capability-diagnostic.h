#pragma once
#include "common.h"
#pragma comment(lib, "OneCoreUAP.lib")
static_assert(sizeof(void*) == 8, "The diagnostic is x64-only.");

// Fixed development-only comparison, never a caller-selected capability.
inline constexpr wchar_t registryReadSid[] = L"S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";
struct CapabilityEntry { std::wstring sid; DWORD attributes; };
inline std::wstring capabilitySidText(PSID sid) {
    LPWSTR text = nullptr;
    if (!IsValidSid(sid) || !ConvertSidToStringSidW(sid, &text)) throw WinError("capability-sid");
    std::wstring result;
    try { result = text; } catch (...) { LocalFree(text); throw; }
    LocalFree(text); return result;
}
inline std::vector<CapabilityEntry> inspectCapabilities(HANDLE process) {
    HANDLE raw = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) throw WinError("capability-token");
    Handle token(raw); auto bytes = tokenInfo(token.value, TokenCapabilities);
    if (bytes.size() < sizeof(DWORD)) throw WinError("capability-buffer", ERROR_INVALID_DATA);
    const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());
    if (groups->GroupCount == 0) return {};
    if (groups->GroupCount > 16 || offsetof(TOKEN_GROUPS, Groups) + groups->GroupCount * sizeof(SID_AND_ATTRIBUTES) > bytes.size()) throw WinError("capability-count", ERROR_INVALID_DATA);
    std::vector<CapabilityEntry> result;
    const auto base = reinterpret_cast<ULONG_PTR>(bytes.data());
    for (DWORD i = 0; i < groups->GroupCount; ++i) {
        const auto& item = groups->Groups[i]; const auto address = reinterpret_cast<ULONG_PTR>(item.Sid);
        if (address < base || address - base > bytes.size() - 8) throw WinError("capability-pointer", ERROR_INVALID_DATA);
        const auto sid = static_cast<SID*>(item.Sid);
        if (sid->SubAuthorityCount > SID_MAX_SUB_AUTHORITIES || 8 + size_t(sid->SubAuthorityCount) * 4 > bytes.size() - (address-base)) throw WinError("capability-sid-bounds", ERROR_INVALID_DATA);
        result.push_back({capabilitySidText(item.Sid), item.Attributes});
    }
    return result;
}
inline void requireCapabilities(const std::vector<CapabilityEntry>& actual, bool registryRead) {
    if (!registryRead) { if (!actual.empty()) throw WinError("unexpected-capability", ERROR_ACCESS_DENIED); return; }
    if (actual.size() != 1 || actual[0].sid != registryReadSid || actual[0].attributes != SE_GROUP_ENABLED) throw WinError("registry-capability-mismatch", ERROR_ACCESS_DENIED);
}
inline std::string capabilityJson(const std::vector<CapabilityEntry>& entries) {
    std::string result = "[";
    for (const auto& entry : entries) {
        if (result.size() > 1) result += ",";
        result += "{\"sid\":\"" + ascii(entry.sid) + "\",\"attributes\":" + std::to_string(entry.attributes) + "}";
    }
    return result + "]";
}
struct RegistryReadCapability {
    PSID* groups = nullptr; DWORD groupCount = 0;
    PSID* capabilities = nullptr; DWORD capabilityCount = 0;
    SID_AND_ATTRIBUTES entry = {};
    ~RegistryReadCapability() {
        if (groups) { for (DWORD i=0; i<groupCount; ++i) LocalFree(groups[i]); LocalFree(groups); }
        if (capabilities) { for (DWORD i=0; i<capabilityCount; ++i) LocalFree(capabilities[i]); LocalFree(capabilities); }
    }
    void derive() {
        if (!DeriveCapabilitySidsFromName(L"registryRead", &groups, &groupCount, &capabilities, &capabilityCount)) throw WinError("derive-registry-capability");
        if (capabilityCount != 1 || !capabilities || capabilitySidText(capabilities[0]) != registryReadSid) throw WinError("derived-capability-mismatch", ERROR_INVALID_DATA);
        entry = {capabilities[0], SE_GROUP_ENABLED};
    }
    RegistryReadCapability() = default;
    RegistryReadCapability(const RegistryReadCapability&) = delete;
    RegistryReadCapability& operator=(const RegistryReadCapability&) = delete;
};
