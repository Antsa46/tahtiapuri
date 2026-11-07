#pragma once
#include "bootstrap-file.h"
#include "broker-journal-codec.h"

namespace mcp_runtime {
// Record-only internal dependency seam. No caller-supplied path, runtime flag
// or environment setting selects an implementation in the production helper.
template<size_t Size> struct FixedReleaseRecordIo {
    static_assert(Size==brokerJournalBytes||Size==2048,"unsupported-fixed-release-record-size");
    using Bytes=std::array<uint8_t,Size>;
    virtual ~FixedReleaseRecordIo()=default;
    virtual bool seek(HANDLE file)const=0;
    virtual bool write(HANDLE file,const Bytes& bytes,DWORD& count)const=0;
    virtual bool truncate(HANDLE file)const=0;
    virtual bool flush(HANDLE file)const=0;
    virtual bool read(HANDLE file,Bytes& bytes,DWORD& count)const=0;
};
template<size_t Size> class WindowsFixedReleaseRecordIo final:public FixedReleaseRecordIo<Size> {
public:
    using Bytes=typename FixedReleaseRecordIo<Size>::Bytes;
    bool seek(HANDLE file)const override{LARGE_INTEGER zero={};return SetFilePointerEx(file,zero,nullptr,FILE_BEGIN)!=FALSE;}
    bool write(HANDLE file,const Bytes& bytes,DWORD& count)const override{
        return WriteFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)!=FALSE;
    }
    bool truncate(HANDLE file)const override{return SetEndOfFile(file)!=FALSE;}
    bool flush(HANDLE file)const override{return FlushFileBuffers(file)!=FALSE;}
    bool read(HANDLE file,Bytes& bytes,DWORD& count)const override{
        return ReadFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)!=FALSE;
    }
};
template<size_t Size> inline const FixedReleaseRecordIo<Size>& windowsFixedReleaseRecordIo(){
    static const WindowsFixedReleaseRecordIo<Size> io;return io;
}
using NativeReleaseRecordIo=FixedReleaseRecordIo<brokerJournalBytes>;
using WindowsReleaseRecordIo=WindowsFixedReleaseRecordIo<brokerJournalBytes>;
using NativeCleanIntentRecordIo=FixedReleaseRecordIo<2048>;
inline const NativeReleaseRecordIo& windowsReleaseRecordIo(){return windowsFixedReleaseRecordIo<brokerJournalBytes>();}
inline const NativeCleanIntentRecordIo& windowsCleanIntentRecordIo(){return windowsFixedReleaseRecordIo<2048>();}
}
