#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <algorithm>
struct WinError : std::runtime_error {
    DWORD code;
    WinError(const char* stage, DWORD value = GetLastError()) : std::runtime_error(stage), code(value) {}
};
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
inline std::wstring quote(const std::wstring& value) {
    std::wstring out = L"\""; size_t slashes = 0;
    for (wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        out.append(slashes * (c == L'"' ? 2 : 1), L'\\'); slashes = 0;
        if (c == L'"') out += L'\\';
        out += c;
    }
    out.append(slashes * 2, L'\\'); return out + L'"';
}
inline void emit(const std::string& line) {
    const std::string data = line + "\n"; DWORD written = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data.data(), static_cast<DWORD>(data.size()), &written, nullptr) || written != static_cast<DWORD>(data.size())) throw WinError("write-report");
}
inline std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
    DWORD bytes = 0; GetTokenInformation(token, kind, nullptr, 0, &bytes);
    if (bytes == 0 || bytes > 65536) throw WinError(("token-size-" + std::to_string(kind)).c_str());
    std::vector<BYTE> result(bytes);
    if (!GetTokenInformation(token, kind, result.data(), bytes, &bytes)) throw WinError("token-info");
    return result;
}
struct TokenView { bool app = false; int lpac = 0; DWORD lpacQueryError = 0; DWORD lpacQueryBytes = 0; DWORD capabilities = 0; DWORD integrity = 0; std::wstring sid; };
inline TokenView inspectToken(HANDLE process) {
    HANDLE raw = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) throw WinError("open-token");
    Handle token(raw); TokenView view;
    auto ac = tokenInfo(token.value, TokenIsAppContainer); view.app = *reinterpret_cast<DWORD*>(ac.data()) != 0;
    if (view.app) {
        DWORD low = 0, bytes = 0;
        if (GetTokenInformation(token.value, TokenIsLessPrivilegedAppContainer, &low, sizeof(low), &bytes)) {
            view.lpacQueryBytes = bytes;
            if (bytes != sizeof(low) || low > 1) throw WinError("lpac-result-size", ERROR_INVALID_DATA);
            view.lpac = low != 0 ? 1 : 0;
        } else { view.lpac = -1; view.lpacQueryError = GetLastError(); view.lpacQueryBytes = bytes; }
    }
    auto caps = tokenInfo(token.value, TokenCapabilities); view.capabilities = reinterpret_cast<TOKEN_GROUPS*>(caps.data())->GroupCount;
    auto il = tokenInfo(token.value, TokenIntegrityLevel); PSID label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
    view.integrity = *GetSidSubAuthority(label, *GetSidSubAuthorityCount(label) - 1);
    if (view.app) {
        auto package = tokenInfo(token.value, TokenAppContainerSid); LPWSTR text = nullptr;
        if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(package.data())->TokenAppContainer, &text)) throw WinError("token-sid");
        view.sid = text; LocalFree(text);
    }
    return view;
}
inline std::string ascii(const std::wstring& value) {
    std::string out; for (wchar_t c : value) { if (c < 32 || c > 126 || c == L'"' || c == L'\\') throw WinError("ascii-field", ERROR_INVALID_DATA); out += static_cast<char>(c); } return out;
}
inline DWORD boundedNumber(const wchar_t* text, DWORD maximum) {
    if (!text || !*text) throw WinError("number", ERROR_INVALID_PARAMETER);
    unsigned long long value = 0;
    for (const wchar_t* p = text; *p; ++p) { if (*p < L'0' || *p > L'9') throw WinError("number", ERROR_INVALID_PARAMETER); const DWORD digit = static_cast<DWORD>(*p - L'0'); if (value > maximum / 10 || (value == maximum / 10 && digit > maximum % 10)) throw WinError("number", ERROR_INVALID_PARAMETER); value = value * 10 + digit; if (value > maximum) throw WinError("number", ERROR_INVALID_PARAMETER); }
    return static_cast<DWORD>(value);
}

inline std::string jsonFlag(int value) { return value < 0 ? "null" : value ? "true" : "false"; }
