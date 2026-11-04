// Included after the shared, fixed-scope probe helpers in host.cpp.
static void inspectDesktopChildren(HANDLE job, DWORD mainPid, std::vector<DWORD>& observed,
    const std::wstring& expectedImage, const TokenView& mainToken) {
    std::vector<BYTE> storage(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 16);
    auto members = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, members, static_cast<DWORD>(storage.size()), nullptr))
        throw WinError("desktop-job-members");
    if (members->NumberOfAssignedProcesses > 16 || members->NumberOfProcessIdsInList > 16)
        throw WinError("desktop-child-count", ERROR_INVALID_DATA);
    for (DWORD n = 0; n < members->NumberOfProcessIdsInList; ++n) {
        const auto raw = members->ProcessIdList[n];
        if (raw > MAXDWORD) throw WinError("desktop-child-id", ERROR_INVALID_DATA);
        const DWORD pid = static_cast<DWORD>(raw);
        if (pid == mainPid || std::find(observed.begin(), observed.end(), pid) != observed.end()) continue;
        if (observed.size() >= 64) throw WinError("desktop-child-budget", ERROR_INVALID_DATA);
        Handle child(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        if (!child.value) {
            if (GetLastError() == ERROR_INVALID_PARAMETER) continue; // Already exited; Job accounting remains authoritative.
            throw WinError("desktop-open-child");
        }
        if (WaitForSingleObject(child.value, 0) == WAIT_OBJECT_0) continue;
        BOOL member = FALSE;
        if (!IsProcessInJob(child.value, job, &member) || !member) throw WinError("desktop-child-job", ERROR_ACCESS_DENIED);
        wchar_t image[2048] = {}; DWORD length = 2048;
        if (!QueryFullProcessImageNameW(child.value, 0, image, &length)) throw WinError("desktop-child-image-query");
        if (_wcsicmp(image, expectedImage.c_str()) != 0) throw WinError("desktop-child-image", ERROR_ACCESS_DENIED);
        const auto token = inspectToken(child.value);
        const auto caps = inspectCapabilities(child.value);
        emit("{\"type\":\"inspected-child\",\"pid\":" + std::to_string(pid) +
            ",\"job\":true,\"imageVerified\":true,\"appContainer\":" + (token.app ? "true" : "false") +
            ",\"sid\":\"" + ascii(token.sid) + "\",\"capabilities\":" + std::to_string(token.capabilities) +
            ",\"capabilitySids\":" + capabilityJson(caps) + ",\"integrity\":" + std::to_string(token.integrity) +
            ",\"lpac\":" + jsonFlag(token.lpac) + ",\"lpacQueryError\":" + std::to_string(token.lpacQueryError) +
            ",\"lpacQueryBytes\":" + std::to_string(token.lpacQueryBytes) + "}");
        requireCapabilities(caps, false);
        if (mainToken.app && (!token.app || token.sid != mainToken.sid || token.integrity > mainToken.integrity))
            throw WinError("desktop-child-token", ERROR_ACCESS_DENIED);
        observed.push_back(pid);
    }
}
