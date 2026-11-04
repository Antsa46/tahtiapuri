// Invented evidence only; no captured identifiers or machine data.
export function startupFixture(mode='lpac',kind='startup-child',code=0){
  const restricted=['ac','lpac'].includes(mode),ok=code===0,child=kind!=='startup-winsock'&&ok;
  const sid='S-1-15-2-101-102-103-104-105-106-107';
  const token={job:true,appContainer:restricted,lpac:restricted?null:false,lpacQueryError:restricted?87:0,lpacQueryBytes:0,capabilities:0,integrity:restricted?4096:8192};
  const rows=[{type:'launched',pid:101,requestedPolicy:mode,aclsVerified:true,sentinelInherited:mode==='control-inherit',...token},{type:'finished',exitCode:0,activeProcesses:0,ownerGone:false}];
  if(restricted)rows.push({type:'profile',sid},{type:'cleanup',hresult:0});
  for(const phase of child?['primary','descendant']:['primary']){
    const noHandles=phase==='descendant'&&kind==='startup-no-inherit';
    rows.push({type:'token',phase,pid:phase==='primary'?101:102,...token,sid:restricted?sid:'',lpacQueryAttempted:restricted,lpacQueryApi:'GetTokenInformation',lpacInfoClass:46,lpacBufferBytes:4},
      {type:'startup-handles',phase,validStdio:noHandles?0:3,handles:['stdin','stdout','stderr'].map((name,i)=>({name,queryOk:!noHandles,flags:noHandles?0:1,error:noHandles?6:0,type:noHandles?0:i===0?2:3,typeError:noHandles?6:0}))});
    for(const [name,allowed] of [['allowed',true],['aap',mode!=='lpac'],['outside',!restricted]])rows.push({type:'startup-read',phase,name,ok:allowed,code:allowed?0:5});
    rows.push({type:'startup-complete',phase});
  }
  rows.push({type:'startup-begin',kind,winsockCallsBefore:0},{type:'startup-result',api:kind==='startup-winsock'?'WSAStartup':'CreateProcessW',ok,code,...(kind==='startup-winsock'?{requestedVersion:514,version:ok?514:null}:{inheritHandles:kind==='startup-child'})});
  if(child)rows.push({type:'descendant',pid:102},{type:'startup-child-exit',pid:102,exitCode:0});
  if(kind==='startup-winsock'&&ok)rows.push({type:'startup-winsock-cleanup',ok:true,code:0});
  const finished=rows.splice(rows.findIndex(r=>r.type==='finished'),1)[0];
  const complete=rows.splice(rows.findIndex(r=>r.type==='startup-complete'&&r.phase==='primary'),1)[0];
  rows.push(complete,finished);
  return {mode,kind,driverPid:99,launchedChildPid:100,probeSha256:'a'.repeat(64),exit:{code:0,signal:null},records:rows.map(r=>({...r,source:r.phase==='descendant'&&kind==='startup-no-inherit'?'child-file':'pipe'})),processExitObservation:{pids:child?[100,101,102]:[100,101],allAbsent:true,beforeCleanup:true},cleanup:{passed:true,stopped:true,profileClean:true,errors:[],deletionAttempts:[{removed:true}],...(restricted?{teardown:{code:0,records:[{type:'cleanup',hresult:0}]}}:{})}};
}
