#pragma once
#include "broker-journal-codec.h"
#include <optional>
#include <utility>

namespace mcp_runtime {
// Owning persistence seam. Production binds this to the retained native file;
// tests may inject failures, never through a worker command or runtime flag.
struct BrokerJournalStorage {
    virtual ~BrokerJournalStorage()=default;
    virtual void verify()=0;
    virtual void write(const JournalBytes& bytes)=0;
    virtual void flush()=0;
    virtual JournalBytes read()=0;
};
class BrokerJournalCommitter {
    BrokerJournalStorage& storage;JournalChecksum checksum;bool healthy_=true;
    std::optional<BrokerJournalRecord> committed;
public:
    BrokerJournalCommitter(BrokerJournalStorage& owned,JournalChecksum digest):storage(owned),checksum(std::move(digest)){}
    bool healthy()const{return healthy_;}
    const BrokerJournalRecord& current()const{
        if(!healthy_||!committed)throw JournalError("mcp-journal-uncommitted");
        return *committed;
    }
    void commit(const BrokerJournalRecord& next){
        if(!healthy_)throw JournalError("mcp-journal-poisoned");
        try{
            const auto bytes=encodeBrokerJournal(next,checksum);
            storage.verify();storage.write(bytes);storage.flush();
            if(storage.read()!=bytes)throw JournalError("mcp-journal-readback");
            storage.verify();committed=next;
        }catch(...){healthy_=false;throw;}
    }
};
}
