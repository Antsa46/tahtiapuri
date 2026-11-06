#pragma once
#include "common.h"

// Current-user identity and allocation ownership only. File and Job ACL
// policies remain separate; this header does not grant access.
namespace windows_runtime {
struct LocalMemory { void* value=nullptr;~LocalMemory(){if(value)LocalFree(value);} };
inline std::wstring sidText(PSID sid) {
    LocalMemory memory; if(!IsValidSid(sid)||!ConvertSidToStringSidW(sid,reinterpret_cast<LPWSTR*>(&memory.value)))throw WinError("sid-text");
    return static_cast<LPWSTR>(memory.value);
}
struct Owner {
    std::vector<BYTE> user; LocalMemory system;std::wstring text;
    Owner(){Handle token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value))throw WinError("owner-token");user=tokenInfo(token.value,TokenUser);text=sidText(sid());
        if(!ConvertStringSidToSidW(L"S-1-5-18",&system.value))throw WinError("system-sid");}
    PSID sid() const{return reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;}
};
}
