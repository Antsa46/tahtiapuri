import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopProgress} from './desktop-results.mjs';
function fixture(mode='ac'){
 const sid=mode==='ac'?'S-1-15-2-1-2-3-4-5-6-7':'';
 const token={appContainer:mode==='ac',sid,capabilities:0,capabilitySids:[],integrity:mode==='ac'?4096:8192,lpac:null,lpacQueryError:87,lpacQueryBytes:0};
 const host=(type,fields={})=>({type,...fields,source:'host'}),worker=(type,fields={})=>({type,...fields,source:'worker'});
 return [
  ...(mode==='ac'?[host('profile',{name:'tahtiapuri.t09g.'+'a'.repeat(32),sid})]:[]),
  host('console-host',{pid:9,soleClient:true,hidden:true,imageVerified:true}),
  host('desktop-limits',{activeProcessLimit:16,affinity:1,priority:'BelowNormal',jobCommitBytes:6442450944,readback:true}),
  host('launched',{...token,pid:10,requestedPolicy:mode,job:true,aclsVerified:true,sentinelInherited:false,capabilityPolicy:'none'}),
  worker('desktop-phase',{phase:'main',pid:10,processType:'browser',electron:'45.2.1',softwareRendering:true}),
  worker('desktop-policy',{pid:10,operations:['package-read','scratch-write','outside-read','outside-write','code-write'].map((name,i)=>({name,ok:mode==='control'||i<2,...(mode==='ac'&&i>=2?{code:'EPERM'}:{})}))}),
  host('inspected-child',{...token,pid:11,job:true,imageVerified:true}),
  worker('desktop-phase',{phase:'renderer-ready',pid:11,sandboxed:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,pageVerified:true}),
  worker('desktop-phase',{phase:'processes',metrics:[{pid:10,type:'Browser',sandboxed:false},{pid:11,type:'Tab',sandboxed:true}]}),
  worker('desktop-phase',{phase:'complete'}),host('finished',{exitCode:0,ownerGone:false,activeProcesses:0,totalProcesses:2}),
  host('console-finished',{detached:true,stopped:true}),...(mode==='ac'?[host('cleanup',{hresult:0})]:[])
 ];
}
for(const mode of ['control','ac'])test('accepts complete '+mode+' GUI evidence',()=>assert.deepEqual(validateDesktopProgress(fixture(mode),mode,'45.2.1','tahtiapuri.t09g.'+'a'.repeat(32)),[10,11,9]));
const get=(rows,type,phase)=>rows.find(row=>row.type===type&&(!phase||row.phase===phase));
const cases=[
 ['debugger record mixed into acceptance evidence',rows=>{rows.push({type:'desktop-debug',kind:'start',source:'host',pid:10});}],
 ['uninspected short-lived child',rows=>{get(rows,'finished').totalProcesses=3;}],
 ['wrong profile instance',rows=>{get(rows,'profile').name='tahtiapuri.t09g.'+'b'.repeat(32);}],
 ['renderer sandbox removed',rows=>{get(rows,'desktop-phase','renderer-ready').sandboxed=false;}],
 ['context isolation removed',rows=>{get(rows,'desktop-phase','renderer-ready').contextIsolation=false;}],
 ['Node exposed',rows=>{get(rows,'desktop-phase','renderer-ready').nodeIntegration=true;}],
 ['wrong renderer PID',rows=>{get(rows,'desktop-phase','renderer-ready').pid=100;}],
 ['missing native child',rows=>{rows.splice(rows.findIndex(r=>r.type==='inspected-child'),1);}],
 ['child escapes Job',rows=>{get(rows,'inspected-child').job=false;}],
 ['unverified child image',rows=>{get(rows,'inspected-child').imageVerified=false;}],
 ['child escapes AC',rows=>{get(rows,'inspected-child').appContainer=false;}],
 ['unexpected child capability',rows=>{get(rows,'inspected-child').capabilitySids=['unexpected'];}],
 ['child changes package identity',rows=>{get(rows,'inspected-child').sid='S-1-15-2-999';}],
 ['child elevation',rows=>{get(rows,'inspected-child').integrity=8192;}],
 ['unobserved metrics PID',rows=>{get(rows,'desktop-phase','processes').metrics.push({pid:99,type:'Utility'});}],
 ['duplicate metrics PID',rows=>{get(rows,'desktop-phase','processes').metrics.push({pid:11,type:'Tab'});}],
 ['renderer metrics unsandboxed',rows=>{get(rows,'desktop-phase','processes').metrics[1].sandboxed=false;}],
 ['worker-forged native launch',rows=>{get(rows,'launched').source='worker';}],
 ['wrong Electron build',rows=>{get(rows,'desktop-phase','main').electron='0.0.0';}],
 ['missing ready round trip',rows=>{rows.splice(rows.findIndex(r=>r.phase==='renderer-ready'),1);}],
 ['expanded process budget',rows=>{get(rows,'desktop-limits').activeProcessLimit=32;}],
 ['expanded CPU affinity',rows=>{get(rows,'desktop-limits').affinity=3;}],
 ['no resource readback',rows=>{get(rows,'desktop-limits').readback=false;}],
 ['outside file read succeeds',rows=>{get(rows,'desktop-policy').operations[2]={name:'outside-read',ok:true};}],
 ['file-not-found substituted for denial',rows=>{get(rows,'desktop-policy').operations[2].code='ENOENT';}],
 ['missing file operation',rows=>{get(rows,'desktop-policy').operations.pop();}],
 ['child still alive',rows=>{get(rows,'finished').activeProcesses=1;}],
 ['console remains',rows=>{get(rows,'console-finished').stopped=false;}],
 ['native timeout',rows=>{rows.push({type:'error',stage:'child-deadline',source:'host'});}],
 ['renderer crash',rows=>{rows.push({type:'desktop-phase',phase:'renderer-gone',source:'worker'});}],
 ['profile cleanup fails',rows=>{get(rows,'cleanup').hresult=-1;}],
 ['wrong phase order',rows=>{const index=rows.findIndex(r=>r.phase==='main');const row=rows.splice(index,1)[0];rows.push(row);}],
 ['duplicate completion',rows=>{rows.push({...get(rows,'finished')});}]
];
for(const [name,mutate]of cases)test('rejects '+name,()=>{const rows=fixture();mutate(rows);assert.throws(()=>validateDesktopProgress(rows,'ac','45.2.1','tahtiapuri.t09g.'+'a'.repeat(32)));});
