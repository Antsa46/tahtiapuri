#pragma once
#include "backend-resources.h"
#include <cstring>

namespace backend_runtime {
enum class Phase { Clean,Preparing,ProfileCreating,ProfileOwned,Prepared,Running,Closing,Terminating,Restoring,ProfileDeleted };
inline const char* phaseName(Phase phase) {
    switch(phase){case Phase::Clean:return "CLEAN";case Phase::Preparing:return "PREPARING";case Phase::ProfileCreating:return "PROFILE_CREATING";
    case Phase::ProfileOwned:return "PROFILE_OWNED";case Phase::Prepared:return "PREPARED";case Phase::Running:return "RUNNING";case Phase::Closing:return "CLOSING";
    case Phase::Terminating:return "TERMINATING";case Phase::Restoring:return "RESTORING";case Phase::ProfileDeleted:return "PROFILE_DELETED";}throw WinError("journal-phase",ERROR_INVALID_DATA);
}
inline Phase parsePhase(const std::string& text) {
    for(auto p:{Phase::Clean,Phase::Preparing,Phase::ProfileCreating,Phase::ProfileOwned,Phase::Prepared,Phase::Running,Phase::Closing,Phase::Terminating,Phase::Restoring,Phase::ProfileDeleted})
        if(text==phaseName(p))return p;throw WinError("journal-unknown-phase",ERROR_INVALID_DATA);
}
enum class ProcessState { None,Creating,Recorded };
inline const char* processStateName(ProcessState state) {
    switch(state){case ProcessState::None:return "NONE";case ProcessState::Creating:return "CREATING";case ProcessState::Recorded:return "RECORDED";}throw WinError("journal-process-state",ERROR_INVALID_DATA);
}
inline ProcessState parseProcessState(const std::string& text) {
    for(auto p:{ProcessState::None,ProcessState::Creating,ProcessState::Recorded})if(text==processStateName(p))return p;
    throw WinError("journal-process-state",ERROR_INVALID_DATA);
}
struct JournalRecord {
    Phase phase=Phase::Clean;std::wstring run,job,profile,sid;std::string sessionIdentity,profileState="NONE";
    ProcessState processState=ProcessState::None;DWORD processPid=0;uint64_t processCreationTime=0;
};
struct JournalContext {
    std::string packageDigest,ownerText,stateIdentity,dataIdentity;
};
inline std::vector<std::string> journalLines(const std::string& value) {
    if(value.empty()||value.size()>4096||value.back()!='\n')throw WinError("journal-shape",ERROR_INVALID_DATA);
    std::vector<std::string> lines;size_t start=0;for(size_t at=0;at<value.size();++at){unsigned char c=value[at];if(c=='\n'){lines.push_back(value.substr(start,at-start));start=at+1;}else if(c<32||c>126)throw WinError("journal-character",ERROR_INVALID_DATA);}
    return lines;
}
struct ProfileSid {
    PSID value=nullptr;~ProfileSid(){if(value)FreeSid(value);}ProfileSid()=default;ProfileSid(const ProfileSid&)=delete;ProfileSid& operator=(const ProfileSid&)=delete;
};
inline void verifyProfileSid(const std::wstring& name,PSID sid) {
    if(name.size()>64||!IsValidSid(sid))throw WinError("profile-sid",ERROR_INVALID_SID);
    ProfileSid derived;HRESULT result=DeriveAppContainerSidFromAppContainerName(name.c_str(),&derived.value);
    if(FAILED(result)||!derived.value||!EqualSid(sid,derived.value))throw WinError("profile-derived-sid",FAILED(result)?static_cast<DWORD>(result):ERROR_INVALID_SID);
    SID_IDENTIFIER_AUTHORITY authority=SECURITY_APP_PACKAGE_AUTHORITY;
    if(std::memcmp(GetSidIdentifierAuthority(sid),&authority,sizeof(authority))!=0||*GetSidSubAuthorityCount(sid)!=8||*GetSidSubAuthority(sid,0)!=SECURITY_APP_PACKAGE_BASE_RID)
        throw WinError("profile-sid-shape",ERROR_INVALID_SID);
}
inline std::string creationTimeText(uint64_t value) {
    std::string text(16,'0');const char* digits="0123456789abcdef";
    for(unsigned i=0;i<16;++i){text[15-i]=digits[value&15];value>>=4;}return text;
}
inline DWORD parseProcessPid(const std::string& text) {
    if(text.empty()||text.size()>10||text[0]=='0')throw WinError("journal-process-pid",ERROR_INVALID_DATA);
    uint64_t pid=0;for(char c:text){if(c<'0'||c>'9')throw WinError("journal-process-pid",ERROR_INVALID_DATA);pid=pid*10+unsigned(c-'0');}
    if(!pid||pid>std::numeric_limits<DWORD>::max())throw WinError("journal-process-pid",ERROR_INVALID_DATA);return static_cast<DWORD>(pid);
}
inline uint64_t parseCreationTime(const std::string& text) {
    if(!lowerHex(widen(text),16))throw WinError("journal-process-creation",ERROR_INVALID_DATA);
    uint64_t value=0;for(char c:text)value=(value<<4)|unsigned(c<='9'?c-'0':c-'a'+10);
    if(!value)throw WinError("journal-process-creation",ERROR_INVALID_DATA);return value;
}
inline void validateJournalRecord(const JournalRecord& r,const JournalContext& context) {
    (void)phaseName(r.phase);(void)processStateName(r.processState);
    if(r.processState==ProcessState::Recorded){if(!r.processPid||!r.processCreationTime)throw WinError("journal-process-identity",ERROR_INVALID_DATA);}
    else if(r.processPid||r.processCreationTime)throw WinError("journal-process-empty",ERROR_INVALID_DATA);
    if((r.phase==Phase::Clean||r.phase==Phase::Preparing||r.phase==Phase::ProfileCreating||r.phase==Phase::ProfileOwned)&&r.processState!=ProcessState::None)
        throw WinError("journal-phase-process",ERROR_INVALID_DATA);
    if((r.phase==Phase::Running||r.phase==Phase::Closing)&&r.processState!=ProcessState::Recorded)throw WinError("journal-phase-process",ERROR_INVALID_DATA);
    if(r.processState!=ProcessState::None&&r.profileState!="OWNED"&&r.profileState!="DELETED")throw WinError("journal-process-profile",ERROR_INVALID_DATA);
    if(r.phase==Phase::Clean){if(!r.run.empty()||!r.job.empty()||!r.profile.empty()||!r.sid.empty()||!r.sessionIdentity.empty()||r.profileState!="NONE")throw WinError("journal-clean-fields",ERROR_INVALID_DATA);return;}
    const auto tag=widen(hashBytes(reinterpret_cast<const BYTE*>(context.ownerText.data()),context.ownerText.size()).substr(0,16));
    if(!lowerHex(r.run,32)||!lowerHex(widen(r.sessionIdentity),24)||r.job!=L"Global\\Tahtiapuri.Backend."+tag+L"."+r.run||
        r.profile!=L"tahtiapuri.backend."+tag.substr(0,8)+L"."+r.run||r.profile.size()>64)throw WinError("journal-owned-names",ERROR_INVALID_DATA);
    if(r.profileState!="NONE"&&r.profileState!="CREATING"&&r.profileState!="OWNED"&&r.profileState!="DELETED")throw WinError("journal-profile-state",ERROR_INVALID_DATA);
    if(r.profileState=="OWNED"||r.profileState=="DELETED"){
        LocalMemory sid;if(!ConvertStringSidToSidW(r.sid.c_str(),&sid.value))throw WinError("journal-profile-sid");verifyProfileSid(r.profile,sid.value);
    }else if(!r.sid.empty())throw WinError("journal-unowned-sid",ERROR_INVALID_DATA);
    if((r.phase==Phase::Preparing&&r.profileState!="NONE")||(r.phase==Phase::ProfileCreating&&r.profileState!="CREATING")||
        (r.phase==Phase::ProfileOwned&&r.profileState!="OWNED")||(r.phase==Phase::ProfileDeleted&&r.profileState!="DELETED")||
        ((r.phase==Phase::Prepared||r.phase==Phase::Running||r.phase==Phase::Closing)&&r.profileState!="OWNED"))throw WinError("journal-phase-profile",ERROR_INVALID_DATA);
}
inline std::string serializeJournal(const JournalRecord& r,const JournalContext& context) {
    validateJournalRecord(r,context);auto optional=[](const std::wstring& text){return text.empty()?std::string("-"):narrow(text);};
    std::string body="TAHTIAPURI_BACKEND_JOURNAL_V2\n"+context.packageDigest+"\n"+context.ownerText+"\n"+
        context.stateIdentity+"\n"+context.dataIdentity+"\nOWNER_SYSTEM_PROTECTED_MEDIUM_V1\nCREATION_JOB_LIST_GLOBAL_V1\n"+
        phaseName(r.phase)+"\n"+optional(r.run)+"\n"+optional(r.job)+"\n"+optional(r.profile)+"\n"+(r.sessionIdentity.empty()?"-":r.sessionIdentity)+"\n"+r.profileState+"\n"+optional(r.sid)+"\n"+
        processStateName(r.processState)+"\n"+(r.processState==ProcessState::Recorded?std::to_string(r.processPid):"-")+"\n"+
        (r.processState==ProcessState::Recorded?creationTimeText(r.processCreationTime):"-")+"\n";
    const auto bytes=body+hashBytes(reinterpret_cast<const BYTE*>(body.data()),body.size())+"\n";
    if(journalLines(bytes).size()!=18)throw WinError("journal-field-count",ERROR_INVALID_DATA);return bytes;
}
inline JournalRecord parseJournal(const std::string& bytes,const JournalContext& context) {
    const auto lines=journalLines(bytes);
    if(lines.size()!=18||lines[0]!="TAHTIAPURI_BACKEND_JOURNAL_V2")throw WinError("journal-version-fields",ERROR_INVALID_DATA);
    auto optional=[](const std::string& text){return text=="-"?std::wstring():widen(text);};JournalRecord record;
    record.phase=parsePhase(lines[7]);record.run=optional(lines[8]);record.job=optional(lines[9]);record.profile=optional(lines[10]);record.sessionIdentity=lines[11]=="-"?"":lines[11];record.profileState=lines[12];record.sid=optional(lines[13]);
    record.processState=parseProcessState(lines[14]);
    if(record.processState==ProcessState::Recorded){record.processPid=parseProcessPid(lines[15]);record.processCreationTime=parseCreationTime(lines[16]);}
    else if(lines[15]!="-"||lines[16]!="-")throw WinError("journal-process-empty",ERROR_INVALID_DATA);
    if(serializeJournal(record,context)!=bytes)throw WinError("journal-authentication",ERROR_INVALID_DATA);return record;
}
}
