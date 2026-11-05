import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResult} from './node-stdio-results.mjs';

const nodeVersion='24.22.2',exit={code:0,signal:null};
const options={nodeVersion,creationMode:'no-window-candidate'};
const frame=(op,id,body=Buffer.alloc(0))=>({type:'worker-frame',op,id,bodyHex:body.toString('hex')});
function rows(kind='normal',mode='control',creationMode=options.creationMode){
  const operations=['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>{
    const allowed=mode==='control'||name==='package-read'||name==='scratch-write'||(mode==='ac'&&name==='aap-read');
    return allowed?{name,ok:true}:{name,ok:false,code:'EACCES'};
  });
  const launch={type:'launched',pid:123,requestedPolicy:mode,creationMode,appContainer:mode!=='control',
    lpac:mode==='lpac',lpacQueryError:0,lpacQueryBytes:0,
    capabilitySids:mode==='lpac'?[{sid:'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681',attributes:4}]:[],
    integrity:mode==='control'?8192:4096,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,
    sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
  const ready=frame(129,1,Buffer.from(JSON.stringify({node:nodeVersion,pid:123,
    execArgv:['--preserve-symlinks','--preserve-symlinks-main'],operations})));
  const frames=['owner-early','startup-fail'].includes(kind)?[]:[ready];
  if(kind==='normal')frames.push(frame(130,2,Buffer.from('kuu')),frame(130,3,Buffer.alloc(16384,88)),frame(134,4));
  if(kind==='stalled-reader')frames.push(frame(131,2));
  return [launch,...frames,...(kind.startsWith('owner-')?[{type:'await-owner'}]:[]),
    ...(kind==='owner-early'?[]:[{type:'worker-stderr',bodyHex:Buffer.from(kind==='fail'?'SYNTHETIC JS FAILURE\n':'').toString('hex')}]),
    {type:'result',passed:true,launchReported:true,childCreated:true,childResumed:kind!=='owner-early',
      exitCode:{normal:0,fail:17,'owner-loss':42,'owner-early':42,'stalled-reader':42,'startup-fail':19,'invalid-utf8':65}[kind],
      watchdog:kind==='stalled-reader'?2:kind.startsWith('owner-')?1:0,jobEmpty:true,profileDeleted:true,failure:'',error:0}];
}
function changeReady(records,change){
  const ready=JSON.parse(Buffer.from(records[1].bodyHex,'hex').toString('utf8'));change(ready);
  records[1].bodyHex=Buffer.from(JSON.stringify(ready)).toString('hex');
}

test('accepts normal control, AC and LPAC evidence with explicit creation and Node identities',()=>{
  for(const creationMode of ['no-window-candidate','detached-normal-candidate'])for(const mode of ['control','ac','lpac']){
    assert.deepEqual(validateResult(rows('normal',mode,creationMode),mode,'normal',exit,{nodeVersion,creationMode}),
      {pid:123,exitCode:0,consoleAbsent:true,jobEmpty:true,profileDeleted:true});
  }
  const creationMode='detached-control-diagnostic';
  assert.equal(validateResult(rows('normal','control',creationMode),'control','normal',exit,{nodeVersion,creationMode}).pid,123);
});

test('accepts the distinct failure, owner, startup and stalled-reader lifecycle sequences',()=>{
  for(const kind of ['fail','owner-loss','owner-early','stalled-reader','startup-fail','invalid-utf8'])for(const mode of ['control','lpac']){
    assert.equal(validateResult(rows(kind,mode),mode,kind,exit,options).jobEmpty,true);
  }
});

test('retains an unknown LPAC token result without weakening capability or query checks',()=>{
  const records=rows('normal','lpac');Object.assign(records[0],{lpac:null,lpacQueryError:87,lpacQueryBytes:0});
  const original=structuredClone(records);validateResult(records,'lpac','normal',exit,options);assert.deepEqual(records,original);
  for(const patch of [{lpacQueryError:0},{lpacQueryBytes:4},{capabilitySids:[]}]){
    const invalid=structuredClone(records);Object.assign(invalid[0],patch);
    assert.throws(()=>validateResult(invalid,'lpac','normal',exit,options));
  }
});

test('rejects an earlier failed result, duplicate results and records after the final result',()=>{
  for(const mutate of [
    records=>records.splice(-1,0,{...records.at(-1),passed:false,failure:'synthetic-failure',error:5}),
    records=>records.splice(-1,0,{...records.at(-1)}),
    records=>records.push({type:'worker-stderr',bodyHex:''}),
    records=>records.push({type:'unexpected'})
  ]){const records=rows();mutate(records);assert.throws(()=>validateResult(records,'control','normal',exit,options));}
});

test('rejects reordered launch, worker, diagnostics and owner records',()=>{
  for(const [left,right] of [[0,1],[2,3],[4,5]]){
    const records=rows();[records[left],records[right]]=[records[right],records[left]];
    assert.throws(()=>validateResult(records,'control','normal',exit,options));
  }
  const records=rows('owner-loss');[records[1],records[2]]=[records[2],records[1]];
  assert.throws(()=>validateResult(records,'control','owner-loss',exit,options));
});

test('rejects odd, invalid, uppercase and oversized hex and invalid ready UTF-8',()=>{
  for(const bodyHex of ['0','gg','6B7575','00'.repeat(16385)]){
    const records=rows();records[2].bodyHex=bodyHex;
    assert.throws(()=>validateResult(records,'control','normal',exit,options));
  }
  const records=rows();records[1].bodyHex='ff';assert.throws(()=>validateResult(records,'control','normal',exit,options));
});

test('requires exactly one empty bye with the expected identity after both echoes',()=>{
  for(const mutate of [records=>records.splice(4,1),records=>records[4].bodyHex='00',records=>records[4].id=5,
    records=>records.splice(5,0,frame(130,5,Buffer.from('extra')))]){
    const records=rows();mutate(records);assert.throws(()=>validateResult(records,'control','normal',exit,options));
  }
});

test('rejects unexpected broker exit, signal and worker exit status',()=>{
  for(const unexpected of [{code:1,signal:null},{code:0,signal:'SIGTERM'}])
    assert.throws(()=>validateResult(rows(),'control','normal',unexpected,options));
  const records=rows();records.at(-1).exitCode=17;assert.throws(()=>validateResult(records,'control','normal',exit,options));
});

test('rejects failed cleanup, hidden failure and unexpected watchdog termination',()=>{
  for(const patch of [{jobEmpty:false},{profileDeleted:false},{passed:false},{childCreated:false},{childResumed:false},
    {failure:'synthetic-failure'},{error:5},{watchdog:2}]){
    const records=rows();Object.assign(records.at(-1),patch);
    assert.throws(()=>validateResult(records,'control','normal',exit,options));
  }
});

test('rejects wrong identity, forbidden file success, diagnostic scope and extra record fields',()=>{
  for(const change of [ready=>ready.pid=124,ready=>ready.node='0.0.0',ready=>ready.execArgv.push('--inspect')]){
    const records=rows();changeReady(records,change);assert.throws(()=>validateResult(records,'control','normal',exit,options));
  }
  const forbidden=rows('normal','lpac');changeReady(forbidden,ready=>ready.operations[2]={name:'private-read',ok:true});
  assert.throws(()=>validateResult(forbidden,'lpac','normal',exit,options));
  assert.throws(()=>validateResult(rows(),'control','normal',exit,{...options,creationMode:'detached-normal-candidate'}));
  const creationMode='detached-control-diagnostic';
  assert.throws(()=>validateResult(rows('normal','lpac',creationMode),'lpac','normal',exit,{nodeVersion,creationMode}));
  const owner=rows('owner-loss');owner[2].passed=true;
  assert.throws(()=>validateResult(owner,'control','owner-loss',exit,options));
});

test('matrix accepts exactly fifteen planned mode/case pairs and rejects the other AC lifecycles',()=>{
  const creationMode='detached-matrix-candidate';let accepted=0;
  for(const mode of ['control','ac','lpac'])for(const kind of ['normal','fail','owner-loss','owner-early','stalled-reader','startup-fail','invalid-utf8']){
    const action=()=>validateResult(rows(kind,mode,creationMode),mode,kind,exit,{nodeVersion,creationMode});
    if(mode==='ac'&&kind!=='normal')assert.throws(action);else{assert.equal(action().jobEmpty,true);accepted++;}
  }
  assert.equal(accepted,15);
});
