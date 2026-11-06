#pragma once
#include <array>
#include <algorithm>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <vector>

namespace mcp_runtime {
using Bytes=std::vector<uint8_t>;
struct WireError:std::runtime_error{explicit WireError(const char* reason):std::runtime_error(reason){}};
enum class Direction { ToMain, FromMain, ToWorker, FromWorker };
struct BrokerFrame { uint8_t kind;Bytes body; };
inline bool controlDirection(Direction direction){return direction==Direction::ToMain||direction==Direction::FromMain;}
inline uint32_t wire32(const uint8_t* bytes){uint32_t n=0;for(unsigned i=0;i<4;++i)n|=uint32_t(bytes[i])<<(8*i);return n;}
inline void wirePut32(uint8_t* bytes,uint32_t n){for(unsigned i=0;i<4;++i)bytes[i]=uint8_t(n>>(8*i));}
inline void validateFrame(Direction direction,uint8_t kind,size_t size){
    size_t limit=0;int exact=-1;
    switch(direction){
    case Direction::ToMain:if(kind==1)exact=48;else if(kind==6)exact=0;else if(kind==3)limit=16384;break;
    case Direction::FromMain:if(kind==2)exact=16;else if(kind==5)exact=0;else if(kind==4)limit=65536;break;
    case Direction::ToWorker:if(kind==1)limit=16384;else if(kind==2)limit=65536;else if(kind==3)exact=0;break;
    case Direction::FromWorker:if(kind==1)limit=262144;else if(kind==2)limit=16384;else if(kind==4)exact=0;break;
    }
    if(exact>=0?size!=static_cast<size_t>(exact):(!limit||!size||size>limit))throw WireError("frame-kind-or-size");
}
inline Bytes encodeBrokerFrame(Direction direction,const BrokerFrame& frame,uint32_t sequence){
    validateFrame(direction,frame.kind,frame.body.size());Bytes out(16+frame.body.size(),0);
    out[0]='T';out[1]='M';out[2]='C';out[3]=controlDirection(direction)?'T':'P';out[4]=1;out[5]=frame.kind;
    wirePut32(out.data()+8,static_cast<uint32_t>(frame.body.size()));wirePut32(out.data()+12,sequence);
    std::copy(frame.body.begin(),frame.body.end(),out.begin()+16);return out;
}
// The caller supplies one monotonic clock. A trickle does not renew a partial
// frame's deadline. No body allocation precedes all header checks.
class BrokerReader {
    Direction direction;std::array<uint8_t,16> header={};size_t used=0,bodyUsed=0;
    Bytes body;uint32_t sequence=1;uint64_t began=0;bool partial=false,haveHeader=false;
public:
    explicit BrokerReader(Direction value):direction(value){}
    void check(uint64_t now) const{if(partial&&now>=began&&now-began>=2000)throw WireError("partial-frame-timeout");}
    void end() const{if(partial)throw WireError("truncated-frame");}
    void write(const uint8_t* bytes,size_t size,uint64_t now,const std::function<void(BrokerFrame)>& receive){
        check(now);
        while(size){
            if(!partial){partial=true;began=now;}
            if(!haveHeader){
                const auto take=std::min(size,header.size()-used);std::copy_n(bytes,take,header.data()+used);bytes+=take;size-=take;used+=take;
                if(used<header.size())continue;
                if(header[0]!='T'||header[1]!='M'||header[2]!='C'||header[3]!=(controlDirection(direction)?'T':'P')||header[4]!=1||header[6]||header[7]||wire32(header.data()+12)!=sequence)
                    throw WireError("frame-header");
                const auto length=wire32(header.data()+8);validateFrame(direction,header[5],length);body.resize(length);bodyUsed=0;haveHeader=true;
            }
            const auto take=std::min(size,body.size()-bodyUsed);if(take)std::copy_n(bytes,take,body.data()+bodyUsed);bytes+=take;size-=take;bodyUsed+=take;
            if(bodyUsed==body.size()){
                BrokerFrame frame{header[5],std::move(body)};used=0;bodyUsed=0;haveHeader=false;partial=false;++sequence;
                receive(std::move(frame));
            }
        }
    }
};
inline bool validUtf8(const Bytes& bytes){
    size_t at=0;
    while(at<bytes.size()){
        uint32_t value=bytes[at++];if(value<0x80)continue;
        unsigned more=0;uint32_t minimum=0;
        if(value>=0xc2&&value<=0xdf){value&=0x1f;more=1;minimum=0x80;}
        else if(value>=0xe0&&value<=0xef){value&=0x0f;more=2;minimum=0x800;}
        else if(value>=0xf0&&value<=0xf4){value&=7;more=3;minimum=0x10000;}
        else return false;
        if(bytes.size()-at<more)return false;
        for(unsigned i=0;i<more;++i){const uint8_t next=bytes[at++];if((next&0xc0)!=0x80)return false;value=(value<<6)|(next&0x3f);}
        if(value<minimum||value>0x10ffff||(value>=0xd800&&value<=0xdfff))return false;
    }
    return true;
}
// Worker DEV is a byte stream. Assemble a bounded UTF-8 line, then let Main's
// existing strict JSON/schema validator decide whether the request is valid.
class DevelopmentLines {
    Bytes pending;uint64_t began=0;bool partial=false;
public:
    void check(uint64_t now)const{if(partial&&now>=began&&now-began>=2000)throw WireError("development-line-timeout");}
    void end()const{if(partial)throw WireError("truncated-development-line");}
    void write(const Bytes& bytes,uint64_t now,const std::function<void(Bytes)>& receive){
        check(now);
        for(uint8_t value:bytes){
            if(!partial){partial=true;began=now;}
            if(value=='\n'){
                if(!pending.empty()&&pending.back()=='\r')pending.pop_back();
                if(pending.empty()||!validUtf8(pending))throw WireError("development-line-text");
                auto line=std::move(pending);pending.clear();partial=false;receive(std::move(line));
            }else{if(pending.size()>=16384)throw WireError("development-line-size");pending.push_back(value);}
        }
    }
};
}
