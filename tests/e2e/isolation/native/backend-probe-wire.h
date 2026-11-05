#pragma once
#include "../../../../packages/windows-runtime/native/isolated-launcher.h"
#include <condition_variable>
#include <deque>
#include <mutex>
#include <functional>
#include <limits>

// A separate, test-only ABI. The model's TAIP protocol and launcher are unchanged.
namespace backend_probe {
using namespace isolation;
constexpr size_t headerBytes = 48, chunkBytes = 65536;
constexpr size_t requestBytes = 65536, responseBytes = 16 * 1024 * 1024;
constexpr size_t ownerBudget = 4 * 1024 * 1024, childBudget = 64 * 1024 * 1024;
constexpr size_t queueBytes = 256 * 1024;
enum Kind : uint16_t { Start=1, App=2, CloseInput=3, Kill=4,
    Prepared=129, Started=130, ChildChunk=131, Result=132, Stderr=133 };
using Nonce = transport::Session;
inline std::vector<BYTE> bytes(const std::string& value) { return {value.begin(), value.end()}; }
inline uint16_t get16(const BYTE* p) { return uint16_t(p[0]) | uint16_t(uint16_t(p[1]) << 8); }
inline std::vector<BYTE> header(Kind kind, uint32_t sequence, size_t length, const Nonce& nonce) {
    if (!sequence || length > responseBytes) throw WinError("encode-header", ERROR_INVALID_DATA);
    std::vector<BYTE> result(headerBytes, 0);
    result[0]='T'; result[1]='B'; result[2]='I'; result[3]='P'; result[4]=1;
    result[6]=static_cast<BYTE>(kind); result[7]=static_cast<BYTE>(uint16_t(kind) >> 8);
    transport::put32(result.data()+8, sequence);
    transport::put32(result.data()+12, static_cast<uint32_t>(length));
    std::copy(nonce.begin(), nonce.end(), result.begin()+16); return result;
}
struct Decoded { Kind kind; uint32_t sequence; size_t length; };
inline Decoded decode(const std::vector<BYTE>& data, uint32_t expected, const Nonce& nonce, size_t cap) {
    if (data.size()!=headerBytes || data[0]!='T' || data[1]!='B' || data[2]!='I' || data[3]!='P' ||
        get16(data.data()+4)!=1 || !expected || transport::get32(data.data()+8)!=expected ||
        !std::equal(nonce.begin(), nonce.end(), data.begin()+16) || transport::get32(data.data()+12)>cap)
        throw WinError("frame-header", ERROR_INVALID_DATA);
    return {static_cast<Kind>(get16(data.data()+6)), expected, transport::get32(data.data()+12)};
}
// false is clean EOF before the header; any partial header/body is an error.
inline bool readExact(HANDLE input, BYTE* target, size_t length, bool allowEof=false) {
    const size_t original=length;
    while (length) {
        DWORD got=0;
        if (!ReadFile(input, target, static_cast<DWORD>(length), &got, nullptr)) {
            const auto error=GetLastError();
            if (allowEof && length==original && error==ERROR_BROKEN_PIPE) return false;
            throw WinError(error==ERROR_BROKEN_PIPE?"frame-truncated":"pipe-read", error);
        }
        if (!got) { if (allowEof && length==original) return false; throw WinError("frame-truncated", ERROR_INVALID_DATA); }
        target+=got; length-=got;
    }
    return true;
}
struct Failure {
    HANDLE job; std::atomic<int> reason{0}; std::atomic<bool> finished{false};
    std::mutex mutex; std::string stage; DWORD error=0;
    struct ThreadHandle { std::unique_ptr<Handle> handle; bool reporting; };
    std::vector<ThreadHandle> threads;
    explicit Failure(HANDLE value):job(value) {}
    void fail(int cause, const char* name, DWORD code=ERROR_INVALID_DATA) {
        std::lock_guard<std::mutex> lock(mutex);
        if (reason.load()==0) { stage=name; error=code; reason.store(cause); }
    }
    void registerThread(HANDLE thread, bool reporting) {
        auto handle=std::make_unique<Handle>();
        if (!DuplicateHandle(GetCurrentProcess(), thread, GetCurrentProcess(), &handle->value,
            THREAD_TERMINATE, FALSE, 0)) throw WinError("thread-cancel-handle");
        std::lock_guard<std::mutex> lock(mutex); threads.push_back({std::move(handle), reporting});
    }
    void cancel(bool reportingToo) {
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto& thread:threads) if (reportingToo || !thread.reporting) CancelSynchronousIo(thread.handle->value);
    }
    void check() { if (reason.load()) throw WinError("probe-stopped", ERROR_OPERATION_ABORTED); }
};
struct IoTask {
    Handle done,gate; std::thread thread; Failure& failure; std::atomic<bool> stopping{false};
    IoTask(Failure& state, std::function<void()> action, bool reporting=false):failure(state) {
        done.value=CreateEventW(nullptr, TRUE, FALSE, nullptr); gate.value=CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!done.value || !gate.value) throw WinError("io-task-events");
        thread=std::thread([this, action=std::move(action)] {
            WaitForSingleObject(gate.value, INFINITE);
            try { action(); }
            catch (const WinError& error) { if (!stopping.load()) failure.fail(3, error.what(), error.code); }
            catch (...) { if (!stopping.load()) failure.fail(3, "io-task-exception"); }
            SetEvent(done.value);
        });
        try { state.registerThread(thread.native_handle(), reporting); }
        catch (...) { SetEvent(gate.value); CancelSynchronousIo(thread.native_handle()); thread.detach(); TerminateProcess(GetCurrentProcess(), 75); throw; }
        SetEvent(gate.value);
    }
    bool complete() const { return WaitForSingleObject(done.value, 0)==WAIT_OBJECT_0; }
    void stop() { stopping.store(true); CancelSynchronousIo(thread.native_handle()); }
    void join() {
        if (!thread.joinable()) return;
        if (WaitForSingleObject(done.value, 2000)!=WAIT_OBJECT_0) {
            CancelSynchronousIo(thread.native_handle());
            if (WaitForSingleObject(done.value, 1000)!=WAIT_OBJECT_0) TerminateProcess(GetCurrentProcess(), 74);
        }
        thread.join();
    }
    ~IoTask() { join(); }
};
struct Record { Kind kind; std::vector<BYTE> body; bool barrier=false; };
// Includes the active write. Output producers wait for bounded space; owner-input
// admission never waits, so a full worker pipe cannot hide an incoming KILL.
class Queue {
    std::mutex mutex; std::condition_variable changed; std::deque<Record> pending;
    size_t held=0; bool closed=false, cancelled=false;
public:
    void push(Record record, bool waitForSpace, Failure& state, bool reporting=false) {
        const size_t size=headerBytes+record.body.size();
        if (size>queueBytes) throw WinError("queue-item-limit", ERROR_INVALID_DATA);
        std::unique_lock<std::mutex> lock(mutex);
        while (!closed && !cancelled && held>queueBytes-size) {
            if (!waitForSpace) throw WinError("queue-overflow", ERROR_BUFFER_OVERFLOW);
            changed.wait_for(lock, std::chrono::milliseconds(20));
            if (!reporting) state.check();
        }
        if (closed || cancelled) throw WinError("queue-closed", ERROR_OPERATION_ABORTED);
        pending.push_back(std::move(record)); held+=size; changed.notify_all();
    }
    bool take(Record& record, Failure& state, bool reporting=false) {
        std::unique_lock<std::mutex> lock(mutex);
        while (pending.empty() && !closed && !cancelled) {
            changed.wait_for(lock, std::chrono::milliseconds(20)); if (!reporting) state.check();
        }
        if (cancelled) throw WinError("queue-cancelled", ERROR_OPERATION_ABORTED);
        if (pending.empty()) return false;
        record=std::move(pending.front()); pending.pop_front(); return true;
    }
    void complete(const Record& record) {
        std::lock_guard<std::mutex> lock(mutex); held-=headerBytes+record.body.size(); changed.notify_all();
    }
    void finish() { std::lock_guard<std::mutex> lock(mutex); closed=true; changed.notify_all(); }
    void abort() { std::lock_guard<std::mutex> lock(mutex); cancelled=true; changed.notify_all(); }
};
struct Output {
    Queue queue; Nonce nonce; Failure& failure; HANDLE channel; std::unique_ptr<IoTask> task;
    std::atomic<size_t> chunks{0};
    Output(const Nonce& value, Failure& state, HANDLE trustedOutput):nonce(value),failure(state),channel(trustedOutput) {
        task=std::make_unique<IoTask>(state, [this] {
            uint32_t sequence=1; size_t receipts=0; Record record;
            while (queue.take(record, failure, true)) {
                if (!sequence) throw WinError("outer-sequence-wrap", ERROR_INVALID_DATA);
                if (record.kind==ChildChunk) {
                    if (record.body.size()>chunkBytes || ++chunks>2048) throw WinError("chunk-budget", ERROR_INVALID_DATA);
                } else {
                    if (record.body.size()>16384 || (receipts+=record.body.size()+headerBytes)>256*1024)
                        throw WinError("receipt-budget", ERROR_INVALID_DATA);
                }
                const auto first=header(record.kind, sequence++, record.body.size(), nonce);
                transport::writeAll(channel, first.data(), first.size());
                transport::writeAll(channel, record.body.data(), record.body.size());
                queue.complete(record);
            }
        }, true);
    }
    void send(Kind kind, std::vector<BYTE> body={}) { queue.push({kind,std::move(body),false}, true, failure, kind!=ChildChunk); }
    void json(Kind kind, const std::string& body) { send(kind,bytes(body)); }
    void finish() { queue.finish(); task->join(); }
};
}
