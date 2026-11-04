// Fixed-scope startup diagnosis only. Never used by normal acceptance runs.
// The creator thread owns the debug loop; Windows owns the debug event's
// process/thread handles. CreateProcess handles remain separately owned.
class DesktopDebug {
    DWORD pid_ = 0, tid_ = 0, events_ = 0, exceptions_ = 0, strings_ = 0;
    size_t bytes_ = 0;
    HANDLE process_ = nullptr, job_ = nullptr;
    uintptr_t ntdll_ = 0;
    bool active_ = false, loader_ = false;
    static std::wstring pathFor(HANDLE file) {
        wchar_t path[2048] = {};
        const DWORD length = GetFinalPathNameByHandleW(file, path, 2048, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (!length || length >= 2048) return L"";
        std::wstring value(path);
        if (value.compare(0, 4, L"\\\\?\\") == 0) value.erase(0, 4);
        return value;
    }
    void eventBody(const DEBUG_EVENT& event, DWORD& continuation, bool diagnose) {
        if (event.dwProcessId != pid_) throw WinError("desktop-debug-owner", ERROR_ACCESS_DENIED);
        if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
            Handle file(event.u.CreateProcessInfo.hFile);
            process_ = event.u.CreateProcessInfo.hProcess;
            if (event.dwThreadId != tid_) throw WinError("desktop-debug-thread", ERROR_INVALID_DATA);
        } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
            Handle file(event.u.LoadDll.hFile);
            if (diagnose && file.value) {
                wchar_t system[2048] = {};
                const UINT length = GetSystemDirectoryW(system, 2048);
                if (!length || length >= 2048) throw WinError("desktop-debug-system-path");
                const auto expected = std::wstring(system) + L"\\ntdll.dll";
                if (_wcsicmp(pathFor(file.value).c_str(), expected.c_str()) == 0)
                    ntdll_ = reinterpret_cast<uintptr_t>(event.u.LoadDll.lpBaseOfDll);
            }
        } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
            continuation = DBG_EXCEPTION_NOT_HANDLED;
            if (!diagnose) return;
            if (++exceptions_ > 128) throw WinError("desktop-debug-exception-budget", ERROR_INVALID_DATA);
            const auto& record = event.u.Exception.ExceptionRecord;
            MEMORY_BASIC_INFORMATION region = {};
            const bool mapped = VirtualQueryEx(process_, record.ExceptionAddress, &region, sizeof(region)) == sizeof(region);
            const auto base = reinterpret_cast<uintptr_t>(region.AllocationBase);
            const auto address = reinterpret_cast<uintptr_t>(record.ExceptionAddress);
            const bool initial = !loader_ && exceptions_ == 1 && record.ExceptionCode == EXCEPTION_BREAKPOINT
                && event.u.Exception.dwFirstChance == 1 && event.dwThreadId == tid_
                && mapped && region.Type == MEM_IMAGE && ntdll_ != 0 && base == ntdll_;
            if (initial) { loader_ = true; continuation = DBG_CONTINUE; }
            wchar_t path[2048] = {}; std::wstring module;
            const DWORD length = mapped ? K32GetMappedFileNameW(process_, record.ExceptionAddress, path, 2048) : 0;
            if (length && length < 2048) { module.assign(path, length); const auto at = module.find_last_of(L"\\/"); if (at != std::wstring::npos) module.erase(0, at + 1); }
            const std::string moduleBytes(reinterpret_cast<const char*>(module.data()), module.size() * sizeof(wchar_t));
            emit("{\"type\":\"desktop-debug\",\"kind\":\"exception\",\"pid\":" + std::to_string(pid_) +
                ",\"code\":" + std::to_string(record.ExceptionCode) + ",\"firstChance\":" + std::to_string(event.u.Exception.dwFirstChance) +
                ",\"address\":" + std::to_string(address) + ",\"allocationBase\":" + std::to_string(base) +
                ",\"moduleUtf16Base64\":\"" + base64(moduleBytes) + "\",\"rva\":" + std::to_string(mapped && address >= base ? address - base : 0) +
                ",\"loaderCandidate\":" + (initial ? "true" : "false") + ",\"handled\":" + (initial ? "true" : "false") + "}");
        } else if (event.dwDebugEventCode == OUTPUT_DEBUG_STRING_EVENT && diagnose) {
            if (++strings_ > 32) throw WinError("desktop-debug-string-budget", ERROR_INVALID_DATA);
            const auto& info = event.u.DebugString;
            const size_t requested = size_t(info.nDebugStringLength) * (info.fUnicode ? 2u : 1u);
            const size_t bounded = (std::min)(requested, size_t(4096));
            if (bytes_ + bounded > 65536) throw WinError("desktop-debug-byte-budget", ERROR_INVALID_DATA);
            std::string buffer(bounded, '\0'); SIZE_T read = 0;
            const BOOL ok = bounded == 0 || ReadProcessMemory(process_, info.lpDebugStringData, buffer.data(), bounded, &read);
            if (read > bounded) throw WinError("desktop-debug-read-size", ERROR_INVALID_DATA);
            buffer.resize(read); bytes_ += bounded;
            emit("{\"type\":\"desktop-debug\",\"kind\":\"string\",\"pid\":" + std::to_string(pid_) +
                ",\"unicode\":" + (info.fUnicode ? "true" : "false") + ",\"requestedBytes\":" + std::to_string(requested) +
                ",\"readBytes\":" + std::to_string(read) + ",\"complete\":" + (ok && read == requested ? "true" : "false") +
                ",\"data\":\"" + base64(buffer) + "\"}");
        } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT && diagnose) {
            emit("{\"type\":\"desktop-debug\",\"kind\":\"exit\",\"pid\":" + std::to_string(pid_) +
                ",\"exitCode\":" + std::to_string(event.u.ExitProcess.dwExitCode) + ",\"events\":" + std::to_string(events_) + "}");
        }
    }
public:
    void start(DWORD pid, DWORD tid, HANDLE job) {
        pid_ = pid; tid_ = tid; job_ = job; active_ = true;
        if (!DebugSetProcessKillOnExit(TRUE)) throw WinError("desktop-debug-kill-on-exit");
        emit("{\"type\":\"desktop-debug\",\"kind\":\"start\",\"pid\":" + std::to_string(pid_) + ",\"ownMainOnly\":true,\"killOnDebuggerExit\":true}");
    }
    bool active() const { return active_; }
    bool pump(bool diagnose = true) {
        if (!active_) return false;
        DEBUG_EVENT event = {};
        if (!WaitForDebugEventEx(&event, 0)) { if (GetLastError() == ERROR_SEM_TIMEOUT) return false; throw WinError("desktop-debug-wait"); }
        DWORD continuation = event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT ? DBG_EXCEPTION_NOT_HANDLED : DBG_CONTINUE;
        std::exception_ptr failure;
        try {
            // Continue this event even when its capture exceeds the budget.
            ++events_; eventBody(event, continuation, diagnose && events_ <= 4096);
            if (diagnose && events_ > 4096) throw WinError("desktop-debug-event-budget", ERROR_INVALID_DATA);
        } catch (...) { continuation = event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT ? DBG_EXCEPTION_NOT_HANDLED : DBG_CONTINUE; failure = std::current_exception(); }
        if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) throw WinError("desktop-debug-continue");
        if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) { active_ = false; process_ = nullptr; }
        if (failure) std::rethrow_exception(failure);
        return true;
    }
    bool stopIfActive() noexcept {
        if (!active_) return true;
        const bool killed = TerminateJobObject(job_, 42) != FALSE;
        const ULONGLONG until = GetTickCount64() + 3000;
        while (active_ && GetTickCount64() < until) {
            try { if (!pump(false)) Sleep(1); } catch (...) { Sleep(1); }
        }
        // Do not detach or continue an unobserved live process. Debugger exit
        // still kills the target; the outer owner retains failed cleanup evidence.
        return killed && !active_;
    }
};
