#include "../../../apps/mcp/native/bootstrap-file.h"
#include <iostream>
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=3||(std::wstring(argv[1])!=L"--read"&&std::wstring(argv[1])!=L"--lock"&&std::wstring(argv[1])!=L"--read-valid"&&std::wstring(argv[1])!=L"--hold-read"&&std::wstring(argv[1])!=L"--hold-metadata"))return 64;
        const auto value=mcp_runtime::readMainBootstrapFile(argv[2]);
        if(std::wstring(argv[1])==L"--read-valid"){std::cout<<"{\"passed\":true}\n";return 0;}
        if(std::wstring(argv[1])==L"--hold-read"||std::wstring(argv[1])==L"--hold-metadata") {
            const bool metadata=std::wstring(argv[1])==L"--hold-metadata";
            const auto path=L"\\\\?\\"+std::wstring(argv[2]);
            Handle held(CreateFileW(path.c_str(),metadata?FILE_READ_ATTRIBUTES:GENERIC_READ,
                metadata?FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE:FILE_SHARE_READ,
                nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            if(held.value==INVALID_HANDLE_VALUE)throw WinError("test-held-open");
            std::cout<<"held"<<std::endl;
            char byte=0;DWORD count=0;
            if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&byte,1,&count,nullptr)&&GetLastError()!=ERROR_BROKEN_PIPE)
                throw WinError("test-held-stdin");
            return 0;
        }
        if(value.main.pid!=0x01020304||value.main.creationTime!=0x0807060504030201ULL)return 2;
        for(const auto v:value.pipeNonce)if(v!=0x11)return 2;
        for(const auto v:value.generation)if(v!=0x22)return 2;
        for(const auto v:value.launchToken)if(v!=0x33)return 2;
        if(std::wstring(argv[1])==L"--lock") {
            mcp_runtime::BootstrapPin guard(argv[2],false,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES);
            for(const DWORD access:{DWORD(GENERIC_WRITE),DWORD(DELETE)}) {
                const auto path=L"\\\\?\\"+std::wstring(argv[2]);
                Handle conflict(CreateFileW(path.c_str(),access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
                if(conflict.value!=INVALID_HANDLE_VALUE||GetLastError()!=ERROR_SHARING_VIOLATION)return 3;
            }
        }
        std::cout<<"{\"passed\":true}\n";return 0;
    }catch(const WinError& error){std::cerr<<error.what()<<":"<<error.code<<"\n";return 1;}
    catch(const std::exception&){std::cerr<<"bootstrap-format\n";return 1;}
}
