#pragma once
#include "transport-wire.h"
namespace native_model {
using namespace transport;
constexpr Op load=static_cast<Op>(11),loaded=static_cast<Op>(136),computing=static_cast<Op>(137),failed=static_cast<Op>(138);
inline std::vector<BYTE> words(std::initializer_list<uint32_t> values) {
    std::vector<BYTE> body(values.size()*4);size_t offset=0;
    for(uint32_t value:values){put32(body.data()+offset,value);offset+=4;}return body;
}
inline bool available(HANDLE input) {
    DWORD bytes=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&bytes,nullptr)) throw WinError("channel-eof",ERROR_INVALID_DATA);
    return bytes!=0;
}
}
