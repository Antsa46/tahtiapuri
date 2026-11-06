#include "main-peer.h"
#include <iostream>
#include <iomanip>
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=3||std::wstring(argv[1])!=L"--identity")return 64;
        const std::wstring text=argv[2];if(text.empty()||text.front()==L'0'||text.size()>10)return 64;
        DWORD pid=0;try{pid=boundedNumber(argv[2],MAXDWORD);}catch(const WinError&){return 64;}if(!pid)return 64;
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid));
        if(!process.value)throw WinError("identity-open");
        const auto identity=mcp_runtime::queryMainIdentity(process.value);
        std::cout<<"{\"pid\":"<<identity.pid<<",\"creationTime\":\""<<std::hex<<std::setw(16)<<std::setfill('0')<<identity.creationTime<<"\"}\n";
        return std::cout.good()?0:1;
    }catch(const std::exception&){return 1;}
}
