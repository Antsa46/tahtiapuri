import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {KINDS,FrameReader,encodeJson,decodeJson,BoundedWriter} from './backend-codec.mjs';

const MiB=1024*1024;
const registrySid='S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');

export function validatePrepared(value,mode){
  assert(exact(value,['pid','childNonce','requestedPolicy','creationMode','appContainer','lpac','lpacQueryError','lpacQueryBytes','capabilitySids','integrity','job','activeProcessLimit','affinity','priority','jobCommitBytes','sentinelInherited','aclsVerified','consoleAbsent','networkVerified']),'Invalid PREPARED fields');
  assert(Number.isSafeInteger(value.pid)&&value.pid>0&&value.pid<=0xffffffff&&/^[a-f0-9]{64}$/.test(value.childNonce));
  assert.equal(value.requestedPolicy,mode);assert.equal(value.creationMode,'detached-backend-probe');
  for(const name of ['job','aclsVerified','consoleAbsent'])assert.equal(value[name],true);
  assert.equal(value.activeProcessLimit,1);assert.equal(value.affinity,1);assert.equal(value.priority,'BelowNormal');assert.equal(value.jobCommitBytes,536870912);
  assert.equal(value.sentinelInherited,false);assert.equal(value.networkVerified,false);
  assert(Number.isSafeInteger(value.integrity)&&value.integrity>=0&&value.integrity<=0xffffffff);
  if(mode==='control'){
    assert.equal(value.integrity,8192);
    assert.equal(value.appContainer,false);assert.equal(value.lpac,false);assert.equal(value.lpacQueryError,0);assert.equal(value.lpacQueryBytes,0);assert.deepEqual(value.capabilitySids,[]);
  }else{
    assert.equal(mode,'lpac');assert.equal(value.appContainer,true);assert.equal(value.integrity,4096);
    assert((value.lpac===null&&value.lpacQueryError===87&&value.lpacQueryBytes===0)||(value.lpac===true&&value.lpacQueryError===0&&value.lpacQueryBytes===4),'Unaccepted LPAC query');
    assert.deepEqual(value.capabilitySids,[{sid:registrySid,attributes:4}]);
  }
  return value;
}

export function validateNativeResult(value){
  assert(exact(value,['passed','childCreated','childResumed','exitCode','watchdog','jobEmpty','persistentAclRestored','profileDeleted','consoleBefore','consoleAfterFirstFrame','consoleCheckedSequence','framesReceived','bytesReceived','ownerMessages','stderrComplete','stderrBytes','failure','error']),'Invalid RESULT fields');
  for(const name of ['passed','childCreated','childResumed','jobEmpty','persistentAclRestored','profileDeleted','consoleBefore','consoleAfterFirstFrame','stderrComplete'])assert.equal(value[name],true,`Native ${name} failed`);
  assert.equal(value.exitCode,0);assert.equal(value.watchdog,0);assert.equal(value.consoleCheckedSequence,1);
  for(const name of ['framesReceived','bytesReceived','ownerMessages'])assert(Number.isSafeInteger(value[name])&&value[name]>0);
  assert(value.framesReceived<=256&&value.bytesReceived<=64*MiB&&value.ownerMessages<=256);
  assert(Number.isSafeInteger(value.stderrBytes)&&value.stderrBytes>=0&&value.stderrBytes<=16384);
  assert.equal(value.failure,'');assert.equal(value.error,0);return value;
}

export function validateBoundaries(value,mode,session){
  assert(exact(value,['type','session','operations'])&&value.type==='probe.boundaries'&&value.session===session);
  assert(Array.isArray(value.operations));
  assert.deepEqual(value.operations.map(item=>item.name),['package-read','scratch-write','private-read','private-write','code-write','aap-read']);
  for(const item of value.operations){
    const allowed=mode==='control'||['package-read','scratch-write'].includes(item.name);
    if(allowed)assert(exact(item,['name','ok'])&&item.ok===true,'Allowed operation failed');
    else assert(exact(item,['name','ok','code'])&&item.ok===false&&['EACCES','EPERM'].includes(item.code),'Denied operation was not an access denial');
  }
  return value;
}

/** Test-only ChildPort: trusted outer receipts never become backend messages. */
export class BackendProbePort extends EventEmitter {
  constructor(child,{mode,ownerNonce,captureSky}){
    super();assert(['control','lpac'].includes(mode));assert(/^[a-f0-9]{64}$/.test(ownerNonce));
    assert(captureSky===undefined||typeof captureSky==='function');this._captureSky=captureSky;this._skyCaptured=false;
    this.child=child;this.mode=mode;this.ownerNonce=ownerNonce;this.pid=undefined;
    this.records=[];this.nativeEnvelopes=[];this.applicationFrames=[];this.stderr=Buffer.alloc(0);this.brokerStderr=Buffer.alloc(0);this.error=undefined;this._receiptBytes=0;this._outerChunks=0;this._ownerMessages=0;
    this._prepared=deferred();this.prepared=this._prepared.promise;this._completion=deferred();this.completion=this._completion.promise;
    this._fatal=deferred();this.fatal=this._fatal.promise;this._boundaries=deferred();this.boundaries=this._boundaries.promise;
    this._outer=new FrameReader({nonce:this.ownerNonce,maxPayloadBytes:65536,allowedKinds:[KINDS.PREPARED,KINDS.STARTED,KINDS.CHILD_CHUNK,KINDS.RESULT,KINDS.STDERR],maxFrames:8192,maxTotalBytes:66*MiB});
    this._writer=new BoundedWriter(child.stdin,{nonce:this.ownerNonce,allowedKinds:[KINDS.START,KINDS.APP,KINDS.CLOSE_CHILD_INPUT,KINDS.KILL],maxPayloadBytes:65536,maxFrames:260,maxTotalBytes:4*MiB+260*48,maxPendingMessages:32,maxPendingBytes:MiB,onFailure:error=>this._fail(error)});
    this._state='preparing';this._shutdown=undefined;this._sawStderr=false;this._sawResult=false;this._closeSent=false;
    child.stdout.on('data',chunk=>{try{for(const record of this._outer.push(chunk))this._receive(record);}catch(error){this._fail(error);}});
    child.stderr.on('data',chunk=>{if(this.brokerStderr.length+chunk.length>16384)this._fail(new Error('Broker stderr limit'));else this.brokerStderr=Buffer.concat([this.brokerStderr,chunk]);});
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',error=>this._fail(error));
    child.once('error',error=>this._fail(error));
    child.once('close',(code,signal)=>this._closed(code,signal));
  }

  _fail(error){
    if(this.error)return;
    this.error=error instanceof Error?error:new Error(String(error));this._fatal.resolve(this.error);this._prepared.reject(this.error);this._boundaries.reject(this.error);
    if(this._state!=='closed'&&!this._killSent){this._killSent=true;void this._writer?.send(KINDS.KILL,Buffer.alloc(0)).catch(()=>{});}
  }

  _receive(record){
    assert(!this._sawResult,'Record after RESULT');
    if(record.kind!==KINDS.CHILD_CHUNK){
      assert(record.body.length<=16384);this._receiptBytes+=48+record.body.length;assert(this._receiptBytes<=256*1024,'Native receipt budget exceeded');
      this.nativeEnvelopes.push({kind:record.kind,sequence:record.sequence,body:record.body.toString('base64')});
    }
    if(record.kind===KINDS.PREPARED){
      assert.equal(this._state,'preparing');assert(record.body.length<=16384);
      const receipt=validatePrepared(decodeJson(record.body),this.mode);assert.notEqual(receipt.childNonce,this.ownerNonce,'Nonce domains overlap');this.pid=receipt.pid;this.receipt=receipt;this.childNonce=receipt.childNonce;
      this._inner=new FrameReader({nonce:this.childNonce,maxPayloadBytes:16*MiB,allowedKinds:[KINDS.APP],maxFrames:256,maxTotalBytes:64*MiB+256*48});
      this.records.push({kind:'prepared',value:receipt});this._state='prepared';this._prepared.resolve(receipt);return;
    }
    if(record.kind===KINDS.STARTED){
      assert.equal(this._state,'starting');assert.equal(record.body.length,0);this.records.push({kind:'started'});this._state='started';this.emit('spawn');return;
    }
    if(record.kind===KINDS.CHILD_CHUNK){
      assert.equal(this._state,'started');assert(record.body.length>0&&++this._outerChunks<=2048,'Child chunk budget exceeded');
      for(const inner of this._inner.push(record.body)){
        const message=decodeJson(inner.body);this.applicationFrames.push({sequence:inner.sequence,bytes:inner.body.length,sha256:sha256(inner.body),type:message?.type});
        if(this.applicationFrames.length===1)assert(exact(message,['type','protocol','session'])&&message.type==='ready'&&message.protocol===1&&message.session===this.session,'First inner APP is not backend ready');
        if(message?.type==='probe.boundaries'){
          assert(exact(message,['type','session','operations'])&&message.session===this.session);assert.equal(inner.sequence,2);
          assert.equal(this.boundaryReceipt,undefined);this.boundaryReceipt=message;this._boundaries.resolve(message);continue;
        }
        if(this._captureSky&&this._skyCaptureRequestId&&exact(message,['type','protocol','session','id','operation','result'])&&message.type==='response'&&message.protocol===1&&message.session===this.session&&message.id===this._skyCaptureRequestId&&message.operation==='sky.snapshot'){
          assert(!this._skyCaptured&&inner.body.length<=16*MiB,'Raw sky capture budget exceeded');this._skyCaptured=true;
          const returned=this._captureSky(Object.freeze({body:Buffer.from(inner.body),sequence:inner.sequence,session:this.session,requestId:message.id,bytes:inner.body.length,sha256:sha256(inner.body)}));
          if(returned&&typeof returned.then==='function'){void Promise.resolve(returned).catch(error=>this._fail(error));throw new Error('Raw sky observer must be synchronous and return void');}
          assert.equal(returned,undefined,'Raw sky observer must return void');
        }
        this.emit('message',message);
        if(this._shutdown&&exact(message,['type','protocol','session','id','operation','result'])&&message.type==='response'&&message.protocol===1&&message.session===this.session&&message.id===this._shutdown&&message.operation==='runtime.shutdown'&&message.result===null){
          assert(!this._closeSent);this._closeSent=true;
          this._closeDrain=this._writer.send(KINDS.CLOSE_CHILD_INPUT,Buffer.alloc(0)).then(()=>this._writer.expectPeerClose());
          void this._closeDrain.catch(error=>this._fail(error));
        }
      }
      return;
    }
    if(record.kind===KINDS.STDERR){
      assert(!this._sawStderr&&record.body.length<=16384);this._sawStderr=true;this.stderr=Buffer.from(record.body);this.records.push({kind:'stderr',bytes:record.body.length,sha256:sha256(record.body)});return;
    }
    assert.equal(record.kind,KINDS.RESULT);assert(this._sawStderr,'RESULT before STDERR');assert(record.body.length<=16384);
    this._sawResult=true;this.nativeResult=decodeJson(record.body);this.records.push({kind:'result',value:this.nativeResult});
    validateNativeResult(this.nativeResult);assert.equal(this.nativeResult.stderrBytes,this.stderr.length,'Incomplete raw STDERR receipt');
    assert(this._closeDrain,'RESULT before an ordered shutdown close');
    this._writerFinished=this._closeDrain.then(()=>this._writer.seal());
    void this._writerFinished.catch(error=>this._fail(error));
  }

  async activate(){
    await this.prepared;assert.equal(this._state,'prepared');this._state='starting';
    await this._writer.send(KINDS.START,Buffer.alloc(0));
  }

  postMessage(message){
    assert.equal(this._state,'started','Backend channel is not started');if(this.error)throw this.error;assert(!this._closeSent,'Backend input is closed');
    if(message?.type==='initialize'){assert.equal(this.session,undefined);assert(/^[a-f0-9]{64}$/.test(message.session));this.session=message.session;}
    if(message?.type==='request'&&message.operation==='runtime.shutdown'){assert.equal(this._shutdown,undefined);this._shutdown=message.id;}
    if(this._captureSky&&!this._skyCaptureRequestId&&message?.type==='request'&&message.operation==='sky.snapshot'){assert.equal(message.session,this.session);assert.equal(typeof message.id,'string');this._skyCaptureRequestId=message.id;}
    assert(this._ownerMessages<256,'Owner APP frame budget exceeded');const encoded=encodeJson(message,65536);this._ownerMessages++;
    void this._writer.send(KINDS.APP,encoded).catch(error=>this._fail(error));
  }

  kill(){
    if(this._state==='closed')return false;
    this._killSent=true;void this._writer.send(KINDS.KILL,Buffer.alloc(0)).catch(error=>this._fail(error));return true;
  }

  async _closed(code,signal){
    this._state='closed';
    try{
      this._outer.finish();this._inner?.finish();assert.equal(code,0);assert.equal(signal,null);assert.equal(this.brokerStderr.length,0,'Unexpected broker stderr');
      assert(this._sawResult&&this._sawStderr&&this._closeSent&&this._writerFinished,'Incomplete native closure');
      await this._writerFinished;assert(!this.error,this.error?.message);
      const result=validateNativeResult(this.nativeResult);
      assert.equal(result.framesReceived,this.applicationFrames.length);assert.equal(result.bytesReceived,this.applicationFrames.reduce((sum,item)=>sum+item.bytes,0));
      assert.equal(result.ownerMessages,this._ownerMessages);
      this._completion.resolve(result);this.emit('exit',0,null);
    }catch(error){this._fail(error);this._completion.reject(this.error);}
  }

  snapshot(){return {prepared:this.receipt,records:this.records,nativeEnvelopes:this.nativeEnvelopes,applicationFrames:this.applicationFrames,stderr:this.stderr.toString('base64'),brokerStderr:this.brokerStderr.toString('base64'),error:this.error?.message};}
}
