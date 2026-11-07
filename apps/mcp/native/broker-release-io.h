#pragma once
#include "bootstrap-file.h"
#include "broker-journal-codec.h"

namespace mcp_runtime {
// Record-only internal dependency seam. No caller-supplied path, runtime flag
// or environment setting selects an implementation in the production helper.
struct NativeReleaseRecordIo {
    virtual ~NativeReleaseRecordIo()=default;
    virtual bool seek(HANDLE file)const=0;
    virtual bool write(HANDLE file,const JournalBytes& bytes,DWORD& count)const=0;
    virtual bool truncate(HANDLE file)const=0;
    virtual bool flush(HANDLE file)const=0;
    virtual bool read(HANDLE file,JournalBytes& bytes,DWORD& count)const=0;
};
class WindowsReleaseRecordIo final:public NativeReleaseRecordIo {
public:
    bool seek(HANDLE file)const override{LARGE_INTEGER zero={};return SetFilePointerEx(file,zero,nullptr,FILE_BEGIN)!=FALSE;}
    bool write(HANDLE file,const JournalBytes& bytes,DWORD& count)const override{
        return WriteFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)!=FALSE;
    }
    bool truncate(HANDLE file)const override{return SetEndOfFile(file)!=FALSE;}
    bool flush(HANDLE file)const override{return FlushFileBuffers(file)!=FALSE;}
    bool read(HANDLE file,JournalBytes& bytes,DWORD& count)const override{
        return ReadFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)!=FALSE;
    }
};
inline const NativeReleaseRecordIo& windowsReleaseRecordIo(){
    static const WindowsReleaseRecordIo io;return io;
}
}
