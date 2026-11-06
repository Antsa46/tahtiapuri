#pragma once
#include <array>
#include <cstdint>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace mcp_runtime {
constexpr size_t bootstrapBytes = 96;
struct MainIdentity { uint32_t pid = 0; uint64_t creationTime = 0; };
struct MainBootstrap {
    MainIdentity main;
    std::array<uint8_t,16> pipeNonce{}, generation{};
    std::array<uint8_t,32> launchToken{};
};
inline uint32_t bootstrap32(const uint8_t* p) {
    uint32_t result=0; for(unsigned i=0;i<4;++i)result|=uint32_t(p[i])<<(i*8); return result;
}
inline uint64_t bootstrap64(const uint8_t* p) {
    uint64_t result=0; for(unsigned i=0;i<8;++i)result|=uint64_t(p[i])<<(i*8); return result;
}
inline MainBootstrap decodeMainBootstrap(const uint8_t* bytes,size_t size) {
    constexpr uint8_t magic[8]={'T','M','B','O','O','T','1',0};
    if(!bytes||size!=bootstrapBytes)throw std::invalid_argument("main-bootstrap-size");
    for(size_t i=0;i<8;++i)if(bytes[i]!=magic[i])throw std::invalid_argument("main-bootstrap-magic");
    if(bootstrap32(bytes+8)!=1||bootstrap32(bytes+12)!=bootstrapBytes||bootstrap32(bytes+20)!=0)
        throw std::invalid_argument("main-bootstrap-header");
    MainBootstrap value;value.main={bootstrap32(bytes+16),bootstrap64(bytes+24)};
    if(!value.main.pid||!value.main.creationTime)throw std::invalid_argument("main-bootstrap-identity");
    for(size_t i=0;i<16;++i){value.pipeNonce[i]=bytes[32+i];value.generation[i]=bytes[48+i];}
    for(size_t i=0;i<32;++i)value.launchToken[i]=bytes[64+i];
    return value;
}
inline std::wstring mainPipeName(const MainBootstrap& value) {
    std::wstring name=L"\\\\.\\pipe\\tahtiapuri-native-mcp-";
    constexpr wchar_t digits[]=L"0123456789abcdef";
    for(uint8_t byte:value.pipeNonce){name+=digits[byte>>4];name+=digits[byte&15];}
    return name;
}
}
