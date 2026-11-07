#pragma once
#include "broker-session-codec.h"
#include "broker-journal-store.h"

namespace mcp_runtime {
// Shared fixed-size I/O port, independent typed session state. No phase policy
// or native runtime flag lives here; the owning session operations decide order.
class BrokerSessionStore {
    BrokerJournalStorage& storage;JournalChecksum checksum;bool healthy_=true;
    std::optional<BrokerSessionRecord> committed;
    void requireHealthy()const{if(!healthy_)throw JournalError("mcp-session-poisoned");}
public:
    BrokerSessionStore(BrokerJournalStorage& owned,JournalChecksum digest):storage(owned),checksum(std::move(digest)){}
    bool healthy()const{return healthy_;}
    const BrokerSessionRecord& current()const{
        requireHealthy();if(!committed)throw JournalError("mcp-session-uncommitted");return *committed;
    }
    BrokerSessionRecord load(){
        requireHealthy();
        try{
            if(!checksum)throw JournalError("mcp-session-checksum-unavailable");
            storage.verify();const auto bytes=storage.read();
            auto value=decodeBrokerSession(bytes.data(),bytes.size(),checksum);
            storage.verify();committed=value;return value;
        }catch(...){healthy_=false;throw;}
    }
    void commit(const BrokerSessionRecord& next){
        requireHealthy();
        try{
            const auto bytes=encodeBrokerSession(next,checksum);
            storage.verify();storage.write(bytes);storage.flush();
            if(storage.read()!=bytes)throw JournalError("mcp-session-readback");
            storage.verify();committed=next;
        }catch(...){healthy_=false;throw;}
    }
};
}
