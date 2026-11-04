import {modelProfile,modelOptions} from './model-contract.mjs';
import {registryReadSid} from './capability-policy.mjs';
export const runtime={kind:'node',variant:'local-patched',version:'24.22.2',sha256:'a'.repeat(64)};
const host=type=>({type,source:'host'}),worker=type=>({type,source:'worker'});
export function modelCase(mode='lpac',kind='normal'){
 const restricted=mode==='lpac',missing=kind==='missing-model',owner=kind==='owner-loaded';
 const rows=[
  ...(restricted?[{...host('profile'),sid:'S-1-15-2-SYNTHETIC'}]:[]),
  {...host('console-host'),pid:104,soleClient:true,hidden:true,imageVerified:true},
  {...host('model-pin'),present:!missing,...(missing?{missingError:2}:{bytes:modelProfile.bytes,writeError:32,deleteError:32,inherit:false})},
  {...host('model-limits'),activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:6442450944,readback:true},
  {...host('launched'),pid:102,requestedPolicy:mode,job:true,aclsVerified:true,sentinelInherited:false,appContainer:restricted,sid:restricted?'S-1-15-2-SYNTHETIC':'',capabilities:restricted?1:0,capabilitySids:restricted?[{sid:registryReadSid,attributes:4}]:[],capabilityPolicy:restricted?'registryRead':'none',integrity:restricted?4096:8192,lpac:restricted?null:false,lpacQueryError:restricted?87:0,lpacQueryBytes:0},
  {...worker('model-phase'),phase:'runtime',passed:true,runtime,node:'24.22.2',electron:null,uv:'1.52.1',platform:'win32',arch:'x64',resolved:null,imageVerified:true,artifactVerified:true},
  {...worker('model-policy'),pid:102,operations:['package-read','scratch-write','outside-read','outside-write','code-write','weights-fixture-write','aap-read'].map(name=>{const ok=!restricted||['package-read','scratch-write'].includes(name);return {name,ok,...(!ok?{code:'EPERM'}:{})};})},
  ...(!missing?[{...worker('model-phase'),phase:'weights',passed:true,bytes:modelProfile.bytes,sha256:modelProfile.sha256}]:[]),
  {...worker('model-phase'),phase:'cpu',passed:true,gpu:false,buildType:'prebuilt',maxThreads:1},
  ...(missing?[{...worker('model-expected-failure'),phase:'load',code:'ENOENT'}]:[{...worker('model-phase'),phase:'loaded',passed:true,id:modelProfile.id,templateSha256:modelProfile.templateSha256,gpuLayers:0,useMmap:true,size:2000000000,options:{...modelOptions},contextCreated:false,generation:false}])
 ];
 if(owner)rows.push({...worker('model-held'),pid:102},{...host('owner-host'),pid:105});
 else {
  if(!missing)rows.push({...worker('model-phase'),phase:'model-disposed',passed:true,disposed:true});
  rows.push({...worker('model-phase'),phase:'llama-disposed',passed:true,disposed:true},{...host('finished'),ownerGone:false,activeProcesses:0,exitCode:missing?17:0});
  if(!missing)rows.push({...host('model-pin-released'),processesStopped:true});
  rows.push({...host('console-finished'),detached:true,stopped:true});
 }
 return {mode,kind,records:rows,driverPid:99,launchedChildPid:101,startedAtMs:1000,exit:owner?{code:null,signal:'SIGTERM'}:{code:missing?1:0,signal:null},...(owner?{termination:{targetPid:101,targetRole:'owner',signal:'SIGTERM',succeeded:true,targetAliveBeforeRequest:true,requestedAtMs:1500}}:{}),processExitObservation:{pids:owner?[101,102,104,105]:[101,102,104],allAbsent:true,beforeCleanup:true,checkedAtMs:2000}};
}
