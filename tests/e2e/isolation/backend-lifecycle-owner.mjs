import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isReady} from '@tahtiapuri/validation/backend';
import {KINDS,FrameReader,BoundedWriter,encodeJson,decodeJson} from './backend-codec.mjs';
import {validatePrepared,validateBoundaries} from './backend-port.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const kinds=['owner-before-start','early-close','invalid-utf8'];

/** Separate raw owner for deliberate failure cases; never implements ChildPort. */
export class BackendLifecycleOwner {
  constructor(child,{mode,ownerNonce,session}){
    assert(['control','lpac'].includes(mode));assert(/^[a-f0-9]{64}$/.test(ownerNonce)&&/^[a-f0-9]{64}$/.test(session));
    this.child=child;this.mode=mode;this.ownerNonce=ownerNonce;this.session=session;
    this._prepared=deferred();this.prepared=this._prepared.promise;this._ready=deferred();this.ready=this._ready.promise;
    this._fatal=deferred();this.fatal=this._fatal.promise;this._completion=deferred();this.completion=this._completion.promise;
    this.frames=[];this.nativeEnvelopes=[];this.stderr=Buffer.alloc(0);this.brokerStderr=Buffer.alloc(0);this.ownerMessages=0;
    this.started=false;this.writerFailure=null;this._receiptBytes=0;this._chunks=0;this._outerComplete=false;this._innerComplete=false;this._seenResult=false;
    this._reader=new FrameReader({nonce:ownerNonce,allowedKinds:[KINDS.PREPARED,KINDS.STARTED,KINDS.CHILD_CHUNK,KINDS.STDERR,KINDS.RESULT],maxPayloadBytes:65536,maxFrames:64,maxTotalBytes:320*1024});
    this._writer=new BoundedWriter(child.stdin,{nonce:ownerNonce,allowedKinds:[KINDS.START,KINDS.APP,KINDS.CLOSE_CHILD_INPUT,KINDS.KILL],maxPayloadBytes:65536,maxFrames:8,maxTotalBytes:128*1024,maxPendingMessages:8,maxPendingBytes:128*1024,onFailure:error=>{this.writerFailure=error.message;this._fail(error);}});
    child.stdout.on('data',bytes=>{try{for(const record of this._reader.push(bytes))this._receive(record);}catch(error){this._fail(error);}});
    child.stderr.on('data',bytes=>{if(this.brokerStderr.length+bytes.length>16384)this._fail(new Error('Broker stderr limit'));else this.brokerStderr=Buffer.concat([this.brokerStderr,bytes]);});
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',error=>this._fail(error));
    child.once('error',error=>this._fail(error));child.once('close',(code,signal)=>{void this._closed(code,signal);});
  }

  _fail(error){
    if(this.error)return;this.error=error instanceof Error?error:new Error(String(error));
    this._fatal.resolve(this.error);this._prepared.reject(this.error);this._ready.reject(this.error);
  }

  _receive(record){
    assert(!this._seenResult,'Record after RESULT');
    if(record.kind===KINDS.RESULT)this._seenResult=true;
    if(record.kind!==KINDS.CHILD_CHUNK){
      assert(record.body.length<=16384);this._receiptBytes+=48+record.body.length;assert(this._receiptBytes<=256*1024);
      this.nativeEnvelopes.push({kind:record.kind,sequence:record.sequence,bodyBase64:record.body.toString('base64')});
    }
    if(record.kind===KINDS.PREPARED){
      assert(!this.receipt&&!this._startRequested);this.receipt=validatePrepared(decodeJson(record.body),this.mode);
      assert.notEqual(this.receipt.childNonce,this.ownerNonce);this.pid=this.receipt.pid;
      this._inner=new FrameReader({nonce:this.receipt.childNonce,allowedKinds:[KINDS.APP],maxPayloadBytes:16384,maxFrames:2,maxTotalBytes:32768+96});
      this._prepared.resolve(this.receipt);return;
    }
    if(record.kind===KINDS.STARTED){
      assert(this.receipt&&this._startRequested&&!this.started&&record.body.length===0);this.started=true;
      this.ownerMessages++;void this._writer.send(KINDS.APP,encodeJson({type:'initialize',protocol:1,session:this.session},65536)).catch(error=>this._fail(error));return;
    }
    if(record.kind===KINDS.CHILD_CHUNK){
      assert(this.started&&!this._sawStderr&&++this._chunks<=2&&record.body.length>0);
      for(const inner of this._inner.push(record.body)){
        const message=decodeJson(inner.body);
        this.frames.push({sequence:inner.sequence,bytes:inner.body.length,sha256:hash(inner.body),bodyBase64:inner.body.toString('base64')});
        if(inner.sequence===1)assert(isReady(message,this.session),'First frame is not actual backend ready');
        else{assert.equal(inner.sequence,2);validateBoundaries(message,this.mode,this.session);this._ready.resolve(message);}
      }
      return;
    }
    if(record.kind===KINDS.STDERR){assert(!this._sawStderr);this._sawStderr=true;this.stderr=Buffer.from(record.body);return;}
    assert.equal(record.kind,KINDS.RESULT);assert(this._sawStderr);
    const result=decodeJson(record.body);assert(result!==null&&typeof result==='object'&&!Array.isArray(result),'RESULT must be an object');this.result=result;
  }

  async start(){
    await this.prepared;assert(!this._startRequested&&!this.kind);this._startRequested=true;
    await this._writer.send(KINDS.START,Buffer.alloc(0));return this.ready;
  }

  terminate(kind){
    assert(kinds.includes(kind)&&!this.kind,'Invalid or repeated terminal action');this.kind=kind;
    this._terminalPromise=(async()=>{
      await this.prepared;
      if(kind==='owner-before-start'){
        assert(!this._startRequested&&!this.started&&this.frames.length===0);
        await this._writer.end();this.terminal={kind:'owner-eof',drained:true,bodyBase64:''};
      }else{
        await this.ready;assert(this.started&&this.frames.length===2&&!this.error,'Negative input requires validated readiness');
        const invalid=kind==='invalid-utf8',body=invalid?Buffer.from([0xff]):Buffer.alloc(0);
        if(invalid)this.ownerMessages++;
        await this._writer.send(invalid?KINDS.APP:KINDS.CLOSE_CHILD_INPUT,body);await this._writer.drain();await this._writer.seal();
        this.terminal={kind:invalid?'invalid-utf8':'close-child-input',drained:true,bodyBase64:body.toString('base64')};
      }
    })();
    void this._terminalPromise.catch(error=>this._fail(error));return this._terminalPromise;
  }

  async abort(){
    if(this._closedObserved)return;
    try{await this._writer.send(KINDS.KILL,Buffer.alloc(0));await this._writer.drain();}
    catch{if(!this.child.stdin.destroyed)this.child.stdin.end();}
  }

  async _closed(code,signal){
    this._closedObserved=true;this.brokerExitCode=code;this.brokerSignal=signal;
    try{this._reader.finish();this._outerComplete=this.child.stdout.readableEnded===true;}catch(error){this._fail(error);}
    try{this._inner?.finish();this._innerComplete=Boolean(this._inner);}catch(error){this._fail(error);}
    if(!this.receipt||(this._startRequested&&this.frames.length!==2))this._fail(new Error('Broker closed before validated readiness'));
    try{
      assert(this._terminalPromise&&this.receipt&&this._sawStderr&&this.result,'Incomplete negative terminal evidence');
      await this._terminalPromise;if(this.error)throw this.error;
      assert(this._outerComplete&&this._innerComplete,'Incomplete negative framing');this._completion.resolve(this.snapshot());
    }catch(error){this._fail(error);this._completion.reject(this.error);}
  }

  snapshot(){
    return {kind:this.kind,mode:this.mode,session:this.session,prepared:this.receipt,started:this.started,result:this.result,frames:this.frames.map(frame=>({...frame})),stderrBase64:this.stderr.toString('base64'),brokerStderrBase64:this.brokerStderr.toString('base64'),brokerExitCode:this.brokerExitCode,brokerSignal:this.brokerSignal,outerComplete:this._outerComplete,innerComplete:this._innerComplete,ownerMessages:this.ownerMessages,terminal:this.terminal,processesAbsent:false,writerFailure:this.writerFailure};
  }

  audit(){return {nativeEnvelopes:this.nativeEnvelopes,error:this.error?.message};}
}
