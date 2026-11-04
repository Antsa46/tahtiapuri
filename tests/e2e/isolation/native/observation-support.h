#pragma once
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
static std::wstring executableDirectory() {
    std::vector<wchar_t> path(32768); const DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!n || n >= path.size()) throw WinError("own-image"); const std::wstring value(path.data(), n); return value.substr(0, value.find_last_of(L'\\'));
}
static void checkPath(const std::wstring& path) {
    for (size_t i = 3; i <= path.size(); ++i) if (i == path.size() || path[i] == L'\\') { const auto part = path.substr(0, i); const DWORD attributes = GetFileAttributesW(part.c_str()); if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw WinError("path-reparse-or-missing", ERROR_INVALID_DATA); }
}
