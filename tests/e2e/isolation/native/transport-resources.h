#pragma once
#include "common.h"
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
static std::wstring ownedRoot(const std::wstring& input,const std::string& markerValue="TAHTIAPURI_T09H_TRANSPORT_ONLY") {
    if (input.size() > 1024 || input.size() < 4 || input[1] != L':' || input[2] != L'\\' || input.find(L"..") != std::wstring::npos) throw WinError("root", ERROR_INVALID_PARAMETER);
    DWORD length = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr); std::vector<wchar_t> full(length + 1);
    if (!length || !GetFullPathNameW(input.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr)) throw WinError("root");
    std::wstring root(full.data());
    for (size_t at = 3; at <= root.size(); ++at) if (at == root.size() || root[at] == L'\\') regular(root.substr(0, at), true);
    regular(root + L"\\owner.marker", false);
    Handle marker(CreateFileW((root + L"\\owner.marker").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
    char value[64] = {}; DWORD read = 0;
    if (marker.value == INVALID_HANDLE_VALUE || !ReadFile(marker.value, value, 63, &read, nullptr) || std::string(value, read) != markerValue) throw WinError("marker", ERROR_INVALID_DATA);
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

static void setOwnedAcl(const std::wstring& path, PSID package, DWORD access, bool inherit, PSID extraReader = nullptr) {
    const auto actualPath = filePath(path);
    HANDLE raw = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) throw WinError("acl-token"); Handle token(raw);
    auto user = tokenInfo(token.value, TokenUser); PSID owner = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    PSID system = nullptr; if (!ConvertStringSidToSidW(L"S-1-5-18", &system)) throw WinError("system-sid");
    EXPLICIT_ACCESSW rules[4] = {}; const DWORD count = (package ? 3u : 2u) + (extraReader ? 1u : 0u);
    for (DWORD i = 0; i < count; ++i) {
        rules[i].grfAccessMode = SET_ACCESS; rules[i].grfInheritance = inherit ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
        rules[i].Trustee.TrusteeForm = TRUSTEE_IS_SID; rules[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    }
    rules[0].grfAccessPermissions = FILE_ALL_ACCESS; rules[0].Trustee.ptstrName = reinterpret_cast<LPWSTR>(owner);
    rules[1].grfAccessPermissions = FILE_ALL_ACCESS; rules[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(system);
    if (package) { rules[2].grfAccessPermissions = access; rules[2].Trustee.ptstrName = reinterpret_cast<LPWSTR>(package); }
    if (extraReader) { rules[count - 1].grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE; rules[count - 1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(extraReader); }
    PACL acl = nullptr; DWORD result = SetEntriesInAclW(count, rules, nullptr, &acl);
    if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(actualPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
    if (result == ERROR_SUCCESS) {
        PSECURITY_DESCRIPTOR actual = nullptr; PACL readback = nullptr;
        result = GetNamedSecurityInfoW(const_cast<LPWSTR>(actualPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &readback, nullptr, &actual);
        if (result == ERROR_SUCCESS) {
            SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
            bool valid = GetSecurityDescriptorControl(actual, &control, &revision) && (control & SE_DACL_PROTECTED) && readback && readback->AceCount == count;
            bool seen[4] = {};
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
