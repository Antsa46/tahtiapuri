import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isReady,isResponse} from '@tahtiapuri/validation/backend';
import {isModelRun} from '@tahtiapuri/validation/model-wire';
import {KINDS,HEADER,FrameReader,BoundedWriter,frame,encodeJson,decodeJson} from './backend-codec.mjs';
import {validatePrepared,validateBoundaries} from './backend-port.mjs';
import {ADVERSE_CASE_IDS,PENDING_MODEL_PROMPT,SKY_REQUEST_INPUT,CHILD_ABSENCE_BUDGET_MS} from './backend-adverse-contract.mjs';

const MiB=1024*1024;
const pendingCase='owner-eof-model-pending',pressureCase='sky-output-pause-kill';
const pendingInput=Object.freeze({prompt:PENDING_MODEL_PROMPT,backend:'cpu'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

/** Batch B raw evidence owner. It is deliberately not a successful ChildPort. */
export class BackendAdverseOwner {
  constructor(child,{caseId,mode,ownerNonce,session,waitChildAbsent}){
    assert(ADVERSE_CASE_IDS.includes(caseId),'Unknown adverse case');assert(['control','lpac'].includes(mode));
    assert(/^[a-f0-9]{64}$/.test(ownerNonce)&&/^[a-f0-9]{64}$/.test(session));
    assert(caseId!==pressureCase||typeof waitChildAbsent==='function','Pressure requires a process observer');
    this.child=child;this.caseId=caseId;this.mode=mode;this.ownerNonce=ownerNonce;this.session=session;this.waitChildAbsent=waitChildAbsent;
    this._origin=performance.now();this.frames=[];this.nativeEnvelopes=[];this.stderr=Buffer.alloc(0);this.brokerStderr=Buffer.alloc(0);
    this.started=false;this.ownerMessages=0;this.writerFailure=null;this.activity=null;this.partial=null;
    this._receiptBytes=0;this._chunks=0;this._seenResult=false;this._outerComplete=false;this._innerComplete=false;
    this._innerHeader=Buffer.alloc(HEADER);this._headerUsed=0;this._bodyUsed=0;this._innerReserved=0;this._innerBytes=0;
    this._prepared=deferred();this.prepared=this._prepared.promise;this._ready=deferred();this.ready=this._ready.promise;
    this._pending=deferred();this._paused=deferred();this._fatal=deferred();this.fatal=this._fatal.promise;
    this._completion=deferred();this.completion=this._completion.promise;
    this._reader=new FrameReader({nonce:ownerNonce,allowedKinds:[KINDS.PREPARED,KINDS.STARTED,KINDS.CHILD_CHUNK,KINDS.STDERR,KINDS.RESULT],maxPayloadBytes:65536,maxFrames:2052,maxTotalBytes:66*MiB});
    this._writer=new BoundedWriter(child.stdin,{nonce:ownerNonce,allowedKinds:[KINDS.START,KINDS.APP,KINDS.KILL],maxPayloadBytes:65536,maxFrames:4,maxTotalBytes:128*1024,maxPendingMessages:4,maxPendingBytes:128*1024,onFailure:error=>{this.writerFailure=error.message;this._fail(error);}});
    child.stdout.on('data',bytes=>{try{for(const record of this._reader.push(bytes))this._receive(record);}catch(error){this._fail(error);}});
    child.stderr.on('data',bytes=>{if(this.brokerStderr.length+bytes.length>16384)this._fail(new Error('Broker stderr limit'));else this.brokerStderr=Buffer.concat([this.brokerStderr,bytes]);});
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',error=>this._fail(error));
    child.once('error',error=>this._fail(error));child.once('close',(code,signal)=>{void this._closed(code,signal);});
  }

  _fail(error){
    if(this.error)return;this.error=error instanceof Error?error:new Error(String(error));this._fatal.resolve(this.error);
    for(const item of [this._prepared,this._ready,this._pending,this._paused])item.reject(this.error);
  }
  _healthy(){if(this.error)throw this.error;}

  _receive(record){
    this._healthy();assert(!this._seenResult,'Record after RESULT');
    // The terminal flag precedes JSON decoding, including falsy JSON results.
    if(record.kind===KINDS.RESULT)this._seenResult=true;
    if(record.kind!==KINDS.CHILD_CHUNK){
      assert(record.body.length<=16384);this._receiptBytes+=HEADER+record.body.length;assert(this._receiptBytes<=256*1024);
      this.nativeEnvelopes.push({kind:record.kind,sequence:record.sequence,bodyBase64:record.body.toString('base64')});
    }
    if(record.kind===KINDS.PREPARED){
      assert(!this.receipt&&!this._startRequested&&!this._sawStderr);
      this.receipt=validatePrepared(decodeJson(record.body),this.mode);assert.notEqual(this.receipt.childNonce,this.ownerNonce,'Nonce domains overlap');
      this.pid=this.receipt.pid;this._prepared.resolve(this.receipt);return;
    }
    if(record.kind===KINDS.STARTED){
      assert(this.receipt&&this._startRequested&&!this.started&&!this._sawStderr&&record.body.length===0);
      this.started=true;this.ownerMessages++;
      void this._writer.send(KINDS.APP,encodeJson({type:'initialize',protocol:1,session:this.session},65536)).catch(error=>this._fail(error));return;
    }
    if(record.kind===KINDS.CHILD_CHUNK){
      assert(this.started&&!this._sawStderr&&++this._chunks<=2048&&record.body.length>0);this._pushInner(record.body);return;
    }
    if(record.kind===KINDS.STDERR){assert(this.receipt&&!this._sawStderr);this._sawStderr=true;this.stderr=Buffer.from(record.body);return;}
    assert.equal(record.kind,KINDS.RESULT);assert(this.receipt&&this._sawStderr);
    const value=decodeJson(record.body);assert(value!==null&&typeof value==='object'&&!Array.isArray(value),'RESULT must be an object');this.result=value;
  }

  _pushInner(bytes){
    assert(bytes.length<=64*MiB+256*HEADER-this._innerBytes,'Inner byte budget exceeded');this._innerBytes+=bytes.length;
    let offset=0;
    while(offset<bytes.length){
      if(this._headerUsed<HEADER){
        const count=Math.min(HEADER-this._headerUsed,bytes.length-offset);bytes.copy(this._innerHeader,this._headerUsed,offset,offset+count);this._headerUsed+=count;offset+=count;
        if(this._headerUsed<HEADER)break;
        const header=this._innerHeader,sequence=header.readUInt32LE(8),declared=header.readUInt32LE(12);
        assert(header.subarray(0,4).equals(Buffer.from('TBIP'))&&header.readUInt16LE(4)===1&&header.readUInt16LE(6)===KINDS.APP
          &&header.subarray(16).equals(Buffer.from(this.receipt.childNonce,'hex'))&&sequence===this.frames.length+1,'Invalid inner TBIP header');
        const pressure=this.caseId===pressureCase&&sequence===3;
        assert(sequence<=(this.caseId===pendingCase?4:3),'Inner frame count exceeded');
        assert(declared>0&&declared<=(pressure?16*MiB:16384),'Inner payload limit exceeded');
        assert(HEADER+declared<=64*MiB+256*HEADER-this._innerReserved,'Inner reservation budget exceeded');this._innerReserved+=HEADER+declared;
        this._declared=declared;this._bodyUsed=0;
        if(pressure){
          assert(this._requestId&&declared>MiB,'Pressure requires the requested large third frame');
          assert(!this.partial,'Duplicate pressure frame');
          this.partial={sequence:3,headerBase64:header.toString('base64'),declaredBytes:declared,receivedBytes:0,prefixBase64:'',eofError:null};this._prefix=Buffer.alloc(0);this._body=undefined;
        }else{assert(sequence<=2||this.caseId===pendingCase,'Unexpected application frame');this._body=Buffer.allocUnsafe(declared);}
      }
      const count=Math.min(this._declared-this._bodyUsed,bytes.length-offset);
      if(this.partial){
        const prefixCount=Math.min(count,4096-this._prefix.length);
        if(prefixCount)this._prefix=Buffer.concat([this._prefix,bytes.subarray(offset,offset+prefixCount)]);
      }else bytes.copy(this._body,this._bodyUsed,offset,offset+count);
      this._bodyUsed+=count;offset+=count;
      if(this.partial){
        this.partial.receivedBytes=this._bodyUsed;this.partial.prefixBase64=this._prefix.toString('base64');
        const expected=Buffer.from(JSON.stringify({type:'response',protocol:1,session:this.session,id:this._requestId,operation:'sky.snapshot'}).slice(0,-1)+',"result":');
        const compare=Math.min(expected.length,this._prefix.length);assert(this._prefix.subarray(0,compare).equals(expected.subarray(0,compare)),'Pressure response prefix mismatch');
        assert(this._bodyUsed<this._declared,'Pressure frame completed instead of remaining partial');
        if(count&&!this._outputWasPaused)this._pauseOutput();
      }else if(this._bodyUsed===this._declared){
        this._acceptInner(this.frames.length+1,this._body);this._headerUsed=0;this._bodyUsed=0;this._body=undefined;
      }
    }
  }

  _acceptInner(sequence,body){
    const message=decodeJson(body);
    if(sequence===1)assert(isReady(message,this.session),'First frame is not actual backend ready');
    else if(sequence===2)validateBoundaries(message,this.mode,this.session);
    else if(sequence===3){
      assert.equal(this.caseId,pendingCase);assert(this._requestId&&isModelRun(message,this.session),'Expected pending model.run');
      assert.deepEqual(message.input,pendingInput,'Pending model input differs');
      this.activity={requestId:this._requestId,jobId:message.id,input:{...pendingInput},replySent:false};
    }else{
      assert.equal(sequence,4);assert(this.activity&&isResponse(message,this.session),'Expected assistant response');
      assert.equal(message.id,this._requestId);assert.equal(message.operation,'assistant.submit');assert.equal(message.result.ok,true);
      assert.deepEqual(message.result.job,{id:this.activity.jobId,state:'loading',text:'',error:null,info:null},'Pending job is not the matching loading job');
    }
    this.frames.push({sequence,bytes:body.length,sha256:hash(body),bodyBase64:body.toString('base64')});
    if(sequence===2)this._ready.resolve(message);if(sequence===4)this._pending.resolve(message);
  }

  _trace(event){this.activity.trace.push({event,atMs:performance.now()-this._origin});}
  _pauseOutput(){
    assert(this.caseId===pressureCase&&this.frames.length===2&&this.activity&&!this._outputWasPaused);
    this.child.stdout.pause();assert.equal(this.child.stdout.isPaused(),true,'Actual broker stdout was not paused');
    this._outputWasPaused=true;this._outputPaused=true;this.activity.pausedBytes=this._bodyUsed;this._trace('pause');this._paused.resolve();
  }
  /** Synchronous rescue: reading must resume before any broker-close wait. */
  resumeOutput(){
    if(!this._outputPaused)return;this._outputPaused=false;
    try{this.child.stdout.resume();}catch(error){this._fail(error);throw error;}
    this._trace('stdout-resumed');
  }

  async start(){
    await this.prepared;this._healthy();assert([pendingCase,pressureCase].includes(this.caseId),'Prestart case cannot START');
    assert(!this._startRequested&&!this._terminalPromise,'Repeated START');this._startRequested=true;
    await this._writer.send(KINDS.START,Buffer.alloc(0));return this.ready;
  }

  execute(){
    assert(!this._terminalPromise,'Repeated adverse execution');
    // Defer the body so this promise exists before an immediate close callback.
    this._terminalPromise=Promise.resolve().then(()=>this._execute()).finally(()=>{if(this.caseId===pressureCase)this.resumeOutput();});
    void this._terminalPromise.catch(error=>this._fail(error));return this._terminalPromise;
  }
  async _execute(){
    await this.prepared;this._healthy();
    if(this.caseId==='owner-header20-eof-before-start'||this.caseId==='owner-app65537-header-before-start'){
      assert(!this._startRequested&&!this.started&&this.frames.length===0);
      const short=this.caseId==='owner-header20-eof-before-start';
      const header=frame(short?KINDS.START:KINDS.APP,1,this.ownerNonce);
      if(!short)header.writeUInt32LE(65537,12);
      const bytes=short?header.subarray(0,20):header;
      await this._writer.drain();await this._rawWrite(bytes);
      if(short)await this._writer.end();else await this._writer.seal();
      this.terminal={kind:short?'header20-eof':'app65537-header',drained:true,bodyBase64:bytes.toString('base64')};return;
    }
    // start() also supports an explicit caller start before execute().
    if(!this._startRequested){
      this._startRequested=true;await this._writer.send(KINDS.START,Buffer.alloc(0));
    }
    await this.ready;this._healthy();assert.equal(this.frames.length,2);
    const operation=this.caseId===pendingCase?'assistant.submit':'sky.snapshot';this._requestId=randomUUID();
    const input=this.caseId===pendingCase?pendingInput:SKY_REQUEST_INPUT;
    if(this.caseId===pressureCase)this.activity={requestId:this._requestId,input:copy(SKY_REQUEST_INPUT),childPid:this.pid,childAbsenceBudgetMs:CHILD_ABSENCE_BUDGET_MS,trace:[],pausedBytes:0};
    this.ownerMessages++;await this._writer.send(KINDS.APP,encodeJson({type:'request',protocol:1,session:this.session,id:this._requestId,operation,expiresAtUnixMs:Date.now()+5000,input},65536));
    if(this.caseId===pendingCase){
      await this._pending.promise;this._healthy();assert.equal(this.frames.length,4);
      await this._writer.drain();await this._writer.end();this.terminal={kind:'owner-eof',drained:true,bodyBase64:''};return;
    }
    try{
      await this._paused.promise;this._healthy();assert(this._outputPaused&&this.child.stdout.isPaused(),'Pressure lost before KILL');
      this._trace('kill-requested');await this._writer.send(KINDS.KILL,Buffer.alloc(0));await this._writer.drain();this._trace('kill-drained');
      assert(this._outputPaused&&this.child.stdout.isPaused(),'Pressure lost before process check');
      const started=this._origin+this.activity.trace.at(-1).atMs;let timeout;
      try{
        const absent=await Promise.race([Promise.resolve().then(()=>this.waitChildAbsent(this.pid,CHILD_ABSENCE_BUDGET_MS)),new Promise((resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('Child absence deadline exceeded')),CHILD_ABSENCE_BUDGET_MS);})]);
        assert.equal(absent,true,'Child absence observer did not confirm absence');assert(performance.now()-started<=CHILD_ABSENCE_BUDGET_MS,'Child absence deadline exceeded');
      }finally{clearTimeout(timeout);}
      this._healthy();assert(this._outputPaused&&this.child.stdout.isPaused(),'Output resumed before child absence');this._trace('child-absent');
      await this._writer.seal();this.terminal={kind:'kill',drained:true,bodyBase64:''};
    }finally{this.resumeOutput();}
  }

  _rawWrite(bytes){
    assert([20,48].includes(bytes.length));
    return new Promise((resolve,reject)=>{
      let returned=false,callbackDone=false,needsDrain=false,drained=false,done=false;
      const cleanup=()=>{this.child.stdin.removeListener('drain',onDrain);this.child.stdin.removeListener('error',onError);this.child.stdin.removeListener('close',onClose);};
      const fail=error=>{if(done)return;done=true;cleanup();reject(error);};
      const complete=()=>{if(done||!returned||!callbackDone||(needsDrain&&!drained))return;done=true;cleanup();resolve();};
      const onDrain=()=>{drained=true;complete();},onError=error=>fail(error),onClose=()=>fail(new Error('Raw output closed before callback and drain'));
      this.child.stdin.on('drain',onDrain);this.child.stdin.once('error',onError);this.child.stdin.once('close',onClose);
      try{needsDrain=!this.child.stdin.write(bytes,error=>{if(error){fail(error);return;}callbackDone=true;complete();});returned=true;complete();}catch(error){fail(error);}
    });
  }

  async abort(){
    this.resumeOutput();if(this._closedObserved)return;
    try{await this._writer.send(KINDS.KILL,Buffer.alloc(0));await this._writer.drain();await this._writer.seal();}
    catch{if(!this.child.stdin.destroyed)this.child.stdin.end();}
  }

  _finishInner(){
    if(this._headerUsed||this._bodyUsed)throw new Error('Truncated TBIP frame.');
  }

  async _closed(code,signal){
    if(this._closedObserved)return;this._closedObserved=true;this.brokerExitCode=code;this.brokerSignal=signal;
    if(!this.receipt||(this._startRequested&&this.frames.length<2))this._fail(new Error('Broker closed before validated readiness'));
    if(this.started&&this.caseId===pendingCase&&this.frames.length!==4)this._fail(new Error('Broker closed before pending job evidence'));
    if(this.started&&this.caseId===pressureCase&&(!this.partial||!this.partial.receivedBytes))this._fail(new Error('Broker closed before a partial pressure body'));
    try{
      assert(this._terminalPromise,'Missing adverse terminal action');await this._terminalPromise;this._healthy();
      this._reader.finish();this._outerComplete=this.child.stdout.readableEnded===true;assert(this._outerComplete,'Outer stdout did not end');
      let innerError;try{this._finishInner();}catch(error){innerError=error;}
      if(this.caseId===pressureCase){
        assert(innerError instanceof Error&&innerError.message==='Truncated TBIP frame.'&&this.partial&&this._headerUsed===HEADER
          &&this._bodyUsed>0&&this._bodyUsed<this._declared&&this.frames.length===2,'Missing exact partial last third frame');
        assert(!this._outputPaused);this.partial.eofError=innerError.message;this._innerComplete=false;
      }else{if(innerError)throw innerError;this._innerComplete=true;}
      assert(this.receipt&&this._sawStderr&&this._seenResult&&this.result&&this.terminal,'Incomplete adverse terminal evidence');
      assert.equal(this.frames.length,this.caseId===pendingCase?4:this.caseId===pressureCase?2:0,'Unexpected final inner frame count');
      this._completion.resolve(this.snapshot());
    }catch(error){this._fail(error);this._completion.reject(this.error);}
  }

  snapshot(){
    return {caseId:this.caseId,mode:this.mode,ownerNonce:this.ownerNonce,session:this.session,prepared:copy(this.receipt),started:this.started,result:copy(this.result),
      frames:this.frames.map(record=>({...record})),stderrBase64:this.stderr.toString('base64'),brokerStderrBase64:this.brokerStderr.toString('base64'),brokerExitCode:this.brokerExitCode,brokerSignal:this.brokerSignal,
      outerComplete:this._outerComplete,innerComplete:this._innerComplete,ownerMessages:this.ownerMessages,terminal:copy(this.terminal),processesAbsent:false,writerFailure:this.writerFailure,activity:copy(this.activity),partial:copy(this.partial)};
  }
  audit(){return {nativeEnvelopes:this.nativeEnvelopes.map(record=>({...record})),error:this.error?.message};}
}
