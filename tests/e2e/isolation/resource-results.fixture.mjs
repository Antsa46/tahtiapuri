import {startupFixture} from './startup-results.fixture.mjs';
// Invented evidence; never insert captured user/token descriptors here.
export function resourceFixture(mode='lpac'){
  const f=startupFixture(mode,'startup-winsock');f.kind='resource-once';
  const before=f.records.filter(r=>['profile','launched','token'].includes(r.type)).sort((a,b)=>['profile','launched','token'].indexOf(a.type)-['profile','launched','token'].indexOf(b.type));
  const after=f.records.filter(r=>['finished','cleanup'].includes(r.type));
  f.records=[...before,
    ...['self-read','self-execute','allowed','aap','outside'].map(name=>{const ok=name==='aap'?mode!=='lpac':name==='outside'?!['ac','lpac'].includes(mode):true;return{type:'resource-open',name,mask:name==='self-execute'?32:1,disposition:3,ok,code:ok?0:5};}),
    {type:'resource-dacl',api:'GetTokenInformation',infoClass:6,tokenAccess:8,ok:true,code:0,openCode:0,sizingCode:122,neededBytes:40,returnedBytes:40,nullDacl:false,aceCount:1,aclBytes:32,sddl:'D:(A;;GA;;;SY)'},
    {type:'resource-policy',api:'GetProcessMitigationPolicy',policy:'ProcessChildProcessPolicy',bufferBytes:4,ok:true,code:0,flags:0,noChildProcessCreation:false},
    {type:'resource-complete',phase:'primary',observations:7},...after];return f;
}
