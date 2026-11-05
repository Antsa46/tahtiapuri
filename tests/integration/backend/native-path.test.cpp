// Standalone Windows regression: the caller creates one protected, empty work
// directory and owner.marker before launch. Failures preserve every test object.
#include "../../../apps/backend/native/backend-security.h"
#include <winioctl.h>
#include <cstddef>

namespace br = backend_runtime;
namespace {
constexpr char fixtureMarker[] = "TAHTIAPURI_NATIVE_PATH_TEST_V1\n";

void check(bool condition, const char* label) {
    if (!condition) throw WinError(label, ERROR_ASSERTION_FAILURE);
}

template<class Action> void rejected(Action action, const char* label) {
    try { action(); }
    catch (const WinError&) { return; }
    throw WinError(label, ERROR_ASSERTION_FAILURE);
}

std::wstring pathWithLength(size_t length) {
    std::wstring path = L"C:\\boundary";
    while (path.size() + 61 < length) path += L"\\" + std::wstring(60, L'a');
    path += L"\\" + std::wstring(length - path.size() - 1, L'b');
    check(path.size() == length, "boundary-fixture-length");
    return path;
}

void lexicalContract() {
    for (const auto& path : {std::wstring(L"C:\\fixture\\plain.txt"),
            std::wstring(L"C:\\Synthetic T\u00e4hti\\file with spaces.txt"), pathWithLength(320)}) {
        check(br::canonicalPath(path) == path, "normal-dos-path-preserved");
        check(br::filesystemPath(path) == L"\\\\?\\" + path, "filesystem-path-encoding");
    }
    check(br::filesystemPath(L"C:\\") == L"\\\\?\\C:\\", "internal-drive-root");
    check(br::canonicalPath(L"C:\\fixture\\COM10.txt") == L"C:\\fixture\\COM10.txt", "ordinary-device-like-name");
    for (const auto* path : {
            L"\\\\?\\C:\\fixture\\file", L"\\\\.\\C:\\fixture\\file", L"\\\\server\\share\\file",
            L"C:\\fixture\\file:stream", L"C:\\fixture\\.\\file", L"C:\\fixture\\..\\file",
            L"C:\\fixture\\name.", L"C:\\fixture\\name ", L"C:\\fixture\\name. ",
            L"C:\\fixture\\con", L"C:\\fixture\\PrN.txt", L"C:\\fixture\\AUX", L"C:\\fixture\\NUL.log",
            L"C:\\fixture\\cOm1.bin", L"C:\\fixture\\LpT9", L"C:\\fixture\\CON .txt",
            L"C:\\fixture\\COM\u00b9.txt", L"C:\\fixture\\cOm\u00b2", L"C:\\fixture\\LpT\u00b3.log"}) {
        rejected([&] { (void)br::filesystemPath(path); }, "unsafe-filesystem-path-accepted");
    }
    rejected([] { (void)br::filesystemPath(std::wstring(L"C:\\valid") + wchar_t(0) + L"suffix"); }, "nul-path-accepted");

    // Filesystem paths may exceed MAX_PATH; process paths retain separate bounds.
    br::requireProcessPaths(pathWithLength(258), pathWithLength(259));
    rejected([] { br::requireProcessPaths(pathWithLength(259), pathWithLength(259)); }, "cwd-boundary-accepted");
    rejected([] { br::requireProcessPaths(pathWithLength(258), pathWithLength(260)); }, "executable-boundary-accepted");
    rejected([] { br::requireProcessPaths(L"\\\\?\\C:\\fixture", L"C:\\fixture\\node.exe"); }, "process-extended-prefix-accepted");
}

std::wstring randomName() {
    BYTE bytes[16] = {};
    if (BCryptGenRandom(nullptr, bytes, static_cast<ULONG>(sizeof(bytes)), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw WinError("fixture-random-name", ERROR_GEN_FAILURE);
    const wchar_t* digits = L"0123456789abcdef";
    std::wstring name = L"native-path-";
    for (BYTE byte : bytes) { name += digits[byte >> 4]; name += digits[byte & 15]; }
    return name;
}

void createFile(const std::wstring& path, const std::string& contents) {
    Handle file(CreateFileW(br::filesystemPath(path).c_str(), GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) throw WinError("fixture-file-create");
    DWORD written = 0;
    if (!WriteFile(file.value, contents.data(), static_cast<DWORD>(contents.size()), &written, nullptr)
            || written != contents.size()) throw WinError("fixture-file-write");
}

// Junctions need no symlink privilege. Both link and target are owned fixture
// descendants. The link is removed directly; no traversal or recursive cleanup.
void junction(const std::wstring& link, const std::wstring& target) {
    if (!CreateDirectoryW(br::filesystemPath(link).c_str(), nullptr)) throw WinError("fixture-junction-directory");
    Handle handle(CreateFileW(br::filesystemPath(link).c_str(), GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (handle.value == INVALID_HANDLE_VALUE) throw WinError("fixture-junction-open");
    struct MountPoint {
        DWORD tag;
        WORD dataLength, reserved, substituteOffset, substituteLength, printOffset, printLength;
        wchar_t names[2048];
    } buffer = {};
    const std::wstring substitute = L"\\??\\" + target;
    const size_t characters = substitute.size() + 1 + target.size() + 1;
    check(characters <= 2048, "fixture-junction-bound");
    buffer.tag = IO_REPARSE_TAG_MOUNT_POINT;
    buffer.substituteLength = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
    buffer.printOffset = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
    buffer.printLength = static_cast<WORD>(target.size() * sizeof(wchar_t));
    std::copy(substitute.begin(), substitute.end(), buffer.names);
    std::copy(target.begin(), target.end(), buffer.names + substitute.size() + 1);
    buffer.dataLength = static_cast<WORD>(8 + characters * sizeof(wchar_t));
    static_assert(offsetof(MountPoint, names) == 16, "mount-point-layout");
    DWORD returned = 0;
    if (!DeviceIoControl(handle.value, FSCTL_SET_REPARSE_POINT, &buffer, static_cast<DWORD>(8 + buffer.dataLength),
            nullptr, 0, &returned, nullptr)) throw WinError("fixture-junction-set");
}

size_t filesystemContract(const std::wstring& supplied) {
    const auto base = br::canonicalPath(supplied);
    br::Owner owner;
    br::Pinned basePin(base, true);
    br::requireOwner(basePin.handle.value, owner);
    br::verifyAcl(basePin.handle.value, SE_FILE_OBJECT, owner, nullptr, 0, true);
    br::Pinned marker(base + L"\\owner.marker", false, GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ);
    br::requireOwner(marker.handle.value, owner);
    check(br::readSmall(marker.handle.value, 256) == fixtureMarker, "fixture-marker");
    br::exactEntries(base, {L"owner.marker"});

    std::vector<std::wstring> directories;
    std::vector<br::Identity> identities;
    auto createDirectory = [&](const std::wstring& path) {
        basePin.verify();
        if (!CreateDirectoryW(br::filesystemPath(path).c_str(), nullptr)) throw WinError("fixture-directory-create");
        br::Pinned directory(path, true);
        br::requireOwner(directory.handle.value, owner);
        directories.push_back(path);
        identities.push_back(directory.id);
    };
    const auto testRoot = base + L"\\" + randomName();
    createDirectory(testRoot);
    std::wstring deep = testRoot;
    // Bounded segments reproduce the failing package-descendant shape without
    // depending on the caller's root length or on the long-path registry setting.
    for (unsigned i = 0; deep.size() < 320 && i < 16; ++i) {
        deep += L"\\segment-abcdefghijklmnopqrstuv";
        createDirectory(deep);
    }
    check(deep.size() >= 320, "long-directory-fixture");
    const auto leaf = deep + L"\\t\u00e4htikartta result.txt";
    const auto alias = deep + L"\\hardlink.txt";
    const auto link = testRoot + L"\\junction";
    const std::string body = "native backend long path regression\n";
    createFile(leaf, body);
    {
        br::Pinned file(leaf, false, GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ);
        check(br::readSmall(file.handle.value, 256) == body, "long-file-content");
        file.verify();
        br::Pinned directory(deep, true);
        directory.verify();
        br::exactEntries(deep, {L"t\u00e4htikartta result.txt"});
    }
    if (!CreateHardLinkW(br::filesystemPath(alias).c_str(), br::filesystemPath(leaf).c_str(), nullptr))
        throw WinError("fixture-hardlink-create");
    rejected([&] { br::Pinned invalid(alias, false); }, "hardlink-alias-accepted");
    rejected([&] { br::Pinned invalid(leaf, false); }, "hardlink-original-accepted");
    if (!DeleteFileW(br::filesystemPath(alias).c_str())) throw WinError("fixture-hardlink-delete");

    junction(link, deep);
    rejected([&] { br::Pinned invalid(link, true); }, "directory-reparse-accepted");
    if (!RemoveDirectoryW(br::filesystemPath(link).c_str())) throw WinError("fixture-junction-delete");
    {
        br::Pinned file(leaf, false);
        br::requireOwner(file.handle.value, owner);
        file.verify();
    }
    if (!DeleteFileW(br::filesystemPath(leaf).c_str())) throw WinError("long-file-delete");
    br::exactEntries(deep, {});
    for (size_t i = directories.size(); i-- > 0;) {
        {
            br::Pinned directory(directories[i], true);
            check(directory.id == identities[i], "fixture-directory-identity");
            br::exactEntries(directories[i], {});
        }
        if (!RemoveDirectoryW(br::filesystemPath(directories[i]).c_str())) throw WinError("long-directory-delete");
    }
    basePin.verify();
    br::exactEntries(base, {L"owner.marker"});
    return leaf.size();
}
void failureReport(const std::string& text) noexcept {
    const std::string line = text + "\n";
    DWORD written = 0;
    (void)WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        check(argc == 2, "one-protected-work-directory-required");
        lexicalContract();
        const size_t longFileCharacters = filesystemContract(argv[1]);
        // Six cases: normal paths, lexical rejection, process boundaries,
        // long filesystem IO, hardlink rejection, and reparse rejection.
        emit("{\"passed\":true,\"cases\":6,\"longestPath\":" + std::to_string(longFileCharacters) + "}");
        return 0;
    } catch (const WinError& error) {
        failureReport("{\"passed\":false,\"stage\":\"" + std::string(error.what()) + "\",\"error\":"
            + std::to_string(error.code) + "}");
        return 1;
    } catch (...) {
        failureReport("{\"passed\":false,\"stage\":\"unexpected-exception\",\"error\":"
            + std::to_string(ERROR_UNHANDLED_EXCEPTION) + "}");
        return 1;
    }
}
