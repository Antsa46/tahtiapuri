#pragma once
#include "common.h"
#include <array>
#include <functional>
#include <cstdint>
namespace transport {
constexpr size_t headerSize = 48, maxPayload = 16384;
using Session = std::array<BYTE, 32>;
enum class Op : uint16_t { hello=1, echo=2, begin=3, cancel=4, status=5, shutdown=6,
    stall=7, badReply=8, flood=9, crash=10, ready=129, echoed=130, pending=131,
    cancelled=132, state=133, bye=134, done=135 };
struct Frame { Op op; uint32_t id; Session session; std::vector<BYTE> body; };
inline uint32_t get32(const BYTE* p) {
    return uint32_t(p[0]) | (uint32_t(p[1])<<8) | (uint32_t(p[2])<<16) | (uint32_t(p[3])<<24);
}
inline void put32(BYTE* p, uint32_t n) {
    for (unsigned i=0;i<4;++i) p[i]=static_cast<BYTE>(n>>(i*8));
}
inline std::vector<BYTE> encode(const Frame& f) {
    if (f.body.size()>maxPayload || f.id==0) throw WinError("frame-input",ERROR_INVALID_DATA);
    std::vector<BYTE> b(headerSize+f.body.size(),0);
    b[0]='T'; b[1]='A'; b[2]='I'; b[3]='P'; b[4]=1;
    const auto op=static_cast<uint16_t>(f.op); b[6]=static_cast<BYTE>(op); b[7]=static_cast<BYTE>(op>>8);
    put32(&b[8],f.id); put32(&b[12],static_cast<uint32_t>(f.body.size()));
    std::copy(f.session.begin(),f.session.end(),b.begin()+16);
    std::copy(f.body.begin(),f.body.end(),b.begin()+headerSize); return b;
}
inline void writeAll(HANDLE h,const BYTE* p,size_t size) {
    while(size) { DWORD done=0;
        if(!WriteFile(h,p,static_cast<DWORD>(size),&done,nullptr)||done==0) throw WinError("channel-write");
        p+=done;size-=done;
    }
}
inline void send(HANDLE h,const Frame& f) { const auto b=encode(f);writeAll(h,b.data(),b.size()); }
inline void readAll(HANDLE h,BYTE* p,size_t size,ULONGLONG deadline,const std::function<void()>& tick) {
    while(size) {
        if(tick) tick();
        if(GetTickCount64()>=deadline) throw WinError("frame-deadline",WAIT_TIMEOUT);
        DWORD available=0;
        if(!PeekNamedPipe(h,nullptr,0,nullptr,&available,nullptr)) throw WinError("channel-eof",ERROR_INVALID_DATA);
        if(!available) { Sleep(2);continue; }
        const DWORD take=static_cast<DWORD>(std::min<size_t>(available,size));DWORD done=0;
        if(!ReadFile(h,p,take,&done,nullptr)||!done) throw WinError("frame-truncated",ERROR_INVALID_DATA);
        p+=done;size-=done;
    }
}
inline Frame receive(HANDLE h,const Session& session,const std::function<void()>& tick={}) {
    const auto deadline=GetTickCount64()+2500;
    std::array<BYTE,headerSize> header={};readAll(h,header.data(),header.size(),deadline,tick);
    if(header[0]!='T'||header[1]!='A'||header[2]!='I'||header[3]!='P'||header[4]!=1||header[5]!=0
       ||get32(&header[8])==0||get32(&header[12])>maxPayload
       ||!std::equal(session.begin(),session.end(),header.begin()+16))
        throw WinError("frame-header",ERROR_INVALID_DATA);
    Frame f{static_cast<Op>(uint16_t(header[6])|(uint16_t(header[7])<<8)),get32(&header[8]),session,{}};
    f.body.resize(get32(&header[12]));readAll(h,f.body.data(),f.body.size(),deadline,tick);return f;
}
inline Session parseSession(const std::wstring& value) {
    if(value.size()!=64) throw WinError("session",ERROR_INVALID_PARAMETER);
    Session result={};
    for(size_t i=0;i<64;++i) {
        wchar_t c=value[i]; if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f'))) throw WinError("session",ERROR_INVALID_PARAMETER);
        const auto n=static_cast<BYTE>(c<=L'9'?c-L'0':c-L'a'+10);
        result[i/2]=static_cast<BYTE>((result[i/2]<<4)|n);
    } return result;
}
inline std::wstring sessionText(const Session& s) {
    std::wstring out;constexpr wchar_t digits[]=L"0123456789abcdef";
    for(BYTE b:s){out+=digits[b>>4];out+=digits[b&15];}return out;
}
inline HANDLE parseHandle(const wchar_t* value) {
    const DWORD n=boundedNumber(value,MAXDWORD);
    if(!n) throw WinError("channel-handle",ERROR_INVALID_PARAMETER);
    HANDLE h=reinterpret_cast<HANDLE>(static_cast<uintptr_t>(n));
    if(GetFileType(h)!=FILE_TYPE_PIPE) throw WinError("channel-type",ERROR_INVALID_HANDLE);
    return h;
}
inline std::vector<BYTE> number(uint32_t n) { std::vector<BYTE>b(4);put32(b.data(),n);return b; }
}
