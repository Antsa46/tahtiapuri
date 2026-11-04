import {correlationFixture} from './etw-correlation.fixture.mjs';
import {registryReadSid} from './capability-policy.mjs';
export function candidateFixture(){
 const f=correlationFixture();
 for(const [index,c] of f.cases.entries()){
  const restricted=index===1;c.experimentProfile='lpac-registry-read';c.mode=restricted?'lpac':c.mode;
  c.capabilityPolicy=restricted?'registryRead':'none';c.caseLabel=restricted?'lpac-registry-read-normal':`${c.mode}-normal`;c.hostSha256='b'.repeat(64);
  const launch=c.records.find(r=>r.type==='launched'),child=c.records.find(r=>r.type==='descendant');
  c.driverPid=70;c.launchedChildPid=80+index;c.processExitObservation={pids:[c.launchedChildPid,launch.pid,child.pid],allAbsent:true,beforeCleanup:true,checkedAtMs:Date.parse(c.finishedAt)-1};
  launch.requestedPolicy=c.mode;launch.capabilityPolicy=c.capabilityPolicy;
  for(const row of c.records.filter(r=>['launched','token'].includes(r.type))){Object.assign(row,{appContainer:restricted,lpac:restricted?null:false,lpacQueryError:restricted?87:0,lpacQueryBytes:0,capabilities:restricted?1:0,capabilitySids:restricted?[{sid:registryReadSid,attributes:4}]:[],integrity:restricted?4096:8192});}
  if(restricted)for(const row of c.records.filter(r=>r.type==='operation'&&r.name==='aap-read'))Object.assign(row,{ok:false,code:5});
  c.records.find(r=>r.type==='network-identity').appIdHex=Buffer.from(`\\device\\synthetic\\${c.caseLabel}\\staged\\package\\probe.exe\0`,'utf16le').toString('hex');
 }
 f.evidence.records.find(r=>r.kind==='ready').appIdHex=f.cases[1].records.find(r=>r.type==='network-identity').appIdHex;
 return f;
}
