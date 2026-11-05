import {TextDecoder} from 'node:util';

export const HEADER=48;
export const KINDS=Object.freeze({START:1,APP:2,CLOSE_CHILD_INPUT:3,KILL:4,PREPARED:129,STARTED:130,CHILD_CHUNK:131,RESULT:132,STDERR:133});
const known=new Set(Object.values(KINDS));
const integer=(value,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function nonceBytes(nonce){if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))throw new Error('Invalid TBIP nonce.');return Buffer.from(nonce,'hex');}
function limits({nonce,allowedKinds,maxPayloadBytes,maxFrames,maxTotalBytes}){
  const bytes=nonceBytes(nonce),kinds=new Set(allowedKinds);
  if(!kinds.size||[...kinds].some(kind=>!known.has(kind))||!integer(maxPayloadBytes,0,0xffffffff)
    ||!integer(maxFrames,1,0xffffffff)||!integer(maxTotalBytes,0))throw new Error('Invalid TBIP limits.');
  return {bytes,kinds,maxPayloadBytes,maxFrames,maxTotalBytes};
}
function messageError(error){return error instanceof Error?error:new Error(String(error));}

export function frame(kind,sequence,nonce,body=Buffer.alloc(0)){
  const bytes=nonceBytes(nonce);
  if(!known.has(kind)||!integer(sequence,1,0xffffffff)||!Buffer.isBuffer(body)||body.length>0xffffffff)throw new Error('Invalid TBIP frame.');
  const result=Buffer.allocUnsafe(HEADER+body.length);
  result.write('TBIP',0,'ascii');result.writeUInt16LE(1,4);result.writeUInt16LE(kind,6);
  result.writeUInt32LE(sequence,8);result.writeUInt32LE(body.length,12);bytes.copy(result,16);body.copy(result,HEADER);
  return result;
}

export function encodeJson(value,maxBytes){
  if(!integer(maxBytes,0))throw new Error('Invalid JSON budget.');
  const text=JSON.stringify(value);
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>maxBytes)throw new Error('JSON payload exceeds budget.');
  return Buffer.from(text,'utf8');
}
export function decodeJson(buffer){
  if(!Buffer.isBuffer(buffer))throw new Error('JSON input must be bytes.');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer));
}

export class FrameReader {
  constructor(options){
    this.options=limits(options);this.header=Buffer.alloc(HEADER);this.headerUsed=0;this.body=undefined;this.bodyUsed=0;
    this.sequence=1;this.frames=0;this.receivedBytes=0;this.reservedBytes=0;this.failure=undefined;this.finished=false;
  }
  push(chunk){
    if(this.failure)throw this.failure;
    try{
      if(this.finished)throw new Error('TBIP input already ended.');
      if(!Buffer.isBuffer(chunk))throw new Error('TBIP input must be bytes.');
      if(chunk.length>this.options.maxTotalBytes-this.receivedBytes)throw new Error('TBIP byte budget exceeded.');
      this.receivedBytes+=chunk.length;const result=[];let offset=0;
      while(offset<chunk.length){
        if(this.body===undefined){
          const length=Math.min(HEADER-this.headerUsed,chunk.length-offset);
          chunk.copy(this.header,this.headerUsed,offset,offset+length);this.headerUsed+=length;offset+=length;
          if(this.headerUsed<HEADER)break;
          const header=this.header,kind=header.readUInt16LE(6),sequence=header.readUInt32LE(8),bytes=header.readUInt32LE(12);
          if(!header.subarray(0,4).equals(Buffer.from('TBIP'))||header.readUInt16LE(4)!==1
            ||!header.subarray(16,48).equals(this.options.bytes)||!this.options.kinds.has(kind)
            ||sequence!==this.sequence||bytes>this.options.maxPayloadBytes)throw new Error('Invalid TBIP header.');
          if(this.frames>=this.options.maxFrames||HEADER+bytes>this.options.maxTotalBytes-this.reservedBytes)throw new Error('TBIP frame budget exceeded.');
          this.frames++;this.reservedBytes+=HEADER+bytes;this.kind=kind;this.bodyUsed=0;
          // Validate the complete header before this single payload allocation.
          this.body=Buffer.allocUnsafe(bytes);
        }
        const length=Math.min(this.body.length-this.bodyUsed,chunk.length-offset);
        chunk.copy(this.body,this.bodyUsed,offset,offset+length);this.bodyUsed+=length;offset+=length;
        if(this.bodyUsed===this.body.length){
          result.push({kind:this.kind,sequence:this.sequence,body:this.body});
          this.sequence++;this.body=undefined;this.headerUsed=0;this.bodyUsed=0;
        }
      }
      return result;
    }catch(error){this.failure=messageError(error);this.body=undefined;throw this.failure;}
  }
  finish(){
    if(this.failure)throw this.failure;
    if(this.headerUsed||this.body!==undefined){this.failure=new Error('Truncated TBIP frame.');this.body=undefined;throw this.failure;}
    this.finished=true;
  }
}

export class BoundedWriter {
  constructor(stream,options){
    this.options=limits(options);
    if(!stream||typeof stream.write!=='function'||typeof stream.end!=='function'||typeof stream.on!=='function'
      ||!integer(options.maxPendingMessages,1)||!integer(options.maxPendingBytes,0)
      ||(options.onFailure!==undefined&&typeof options.onFailure!=='function'))throw new Error('Invalid TBIP writer.');
    this.stream=stream;this.nonce=options.nonce;this.maxPendingMessages=options.maxPendingMessages;
    this.maxPendingBytes=options.maxPendingBytes;this.onFailure=options.onFailure??(()=>{});
    this.queue=[];this.active=undefined;this.pendingMessages=0;this.pendingBytes=0;this.frames=0;this.totalBytes=0;
    this.sequence=1;this.failure=undefined;this.ending=false;this.finished=false;this.waiters=[];
    this.peerCloseExpected=false;this.peerClosed=false;this.lastCompletedKind=undefined;
    stream.on('error',error=>this.fail(error));
    stream.on('close',()=>{
      if(this.finished)return;
      if(this.peerCloseExpected&&!this.pendingMessages&&!this.active&&!this.queue.length){
        this.peerClosed=true;this.ending=true;this.finished=true;
      }else this.fail(new Error('TBIP output closed before finish.'));
    });
    stream.on('finish',()=>{
      if(!this.ending)this.fail(new Error('TBIP output ended externally.'));
      else{this.finished=true;this.endResolve?.();}
    });
  }
  fail(error){
    if(this.failure)return;
    this.failure=messageError(error);
    if(this.active){this.active.removeDrain?.();this.active.reject(this.failure);this.active=undefined;}
    for(const entry of this.queue)entry.reject(this.failure);
    this.queue=[];this.pendingMessages=0;this.pendingBytes=0;
    for(const waiter of this.waiters)waiter.reject(this.failure);this.waiters=[];this.endReject?.(this.failure);
    try{this.onFailure(this.failure);}catch{}
  }
  send(kind,body){
    if(this.failure)return Promise.reject(this.failure);
    try{
      if(this.ending||this.stream.destroyed||this.stream.writableEnded)throw new Error('TBIP output is closed.');
      if(!this.options.kinds.has(kind)||!Buffer.isBuffer(body)||body.length>this.options.maxPayloadBytes)throw new Error('Invalid TBIP output payload.');
      const bytes=HEADER+body.length;
      if(this.frames>=this.options.maxFrames||bytes>this.options.maxTotalBytes-this.totalBytes
        ||this.pendingMessages>=this.maxPendingMessages||bytes>this.maxPendingBytes-this.pendingBytes)throw new Error('TBIP output budget exceeded.');
      const copy=Buffer.from(body);this.frames++;this.totalBytes+=bytes;this.pendingMessages++;this.pendingBytes+=bytes;
      const promise=new Promise((resolve,reject)=>this.queue.push({kind,body:copy,bytes,resolve,reject}));
      this.pump();return promise;
    }catch(error){this.fail(error);return Promise.reject(this.failure);}
  }
  pump(){
    if(this.failure||this.active||!this.queue.length)return;
    const entry=this.queue.shift();this.active=entry;
    let returned=false,callbackDone=false,needsDrain=false,drained=false;
    const complete=()=>{
      if(this.failure||this.active!==entry||!returned||!callbackDone||(needsDrain&&!drained))return;
      entry.removeDrain();this.active=undefined;this.pendingMessages--;this.pendingBytes-=entry.bytes;
      this.lastCompletedKind=entry.kind;entry.resolve();
      if(!this.pendingMessages){for(const waiter of this.waiters)waiter.resolve();this.waiters=[];}
      queueMicrotask(()=>this.pump());
    };
    const onDrain=()=>{drained=true;complete();};
    entry.removeDrain=()=>this.stream.removeListener('drain',onDrain);
    this.stream.on('drain',onDrain);
    try{
      // Sequence assignment belongs to this one serialized writer, never the producer.
      const encoded=frame(entry.kind,this.sequence++,this.nonce,entry.body);
      needsDrain=!this.stream.write(encoded,error=>{
        if(error){this.fail(error);return;}callbackDone=true;complete();
      });
      returned=true;if(!needsDrain)entry.removeDrain();complete();
    }catch(error){this.fail(error);}
  }
  drain(){
    if(this.failure)return Promise.reject(this.failure);
    if(!this.pendingMessages)return Promise.resolve();
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  end(){
    if(this.endPromise)return this.endPromise;
    if(this.failure)return Promise.reject(this.failure);
    if(this.peerClosed)return Promise.reject(new Error('TBIP peer already closed.'));
    if(this.sealPromise)return Promise.reject(new Error('TBIP output is sealed.'));
    this.ending=true;
    this.endPromise=new Promise((resolve,reject)=>{this.endResolve=resolve;this.endReject=reject;});
    void this.drain().then(()=>{
      if(this.failure)return;
      try{this.stream.end(error=>{if(error)this.fail(error);else{this.finished=true;this.endResolve();}});}
      catch(error){this.fail(error);}
    }).catch(error=>this.fail(error));
    return this.endPromise;
  }
  seal(){
    if(this.sealPromise)return this.sealPromise;
    if(this.failure)return Promise.reject(this.failure);
    if(this.peerClosed){this.sealPromise=Promise.resolve();return this.sealPromise;}
    if(this.ending)return Promise.reject(new Error('TBIP output is already ending.'));
    this.ending=true;
    // An owner keeps stdin open through the broker's final cleanup and actual close.
    this.sealPromise=this.drain().then(()=>{if(this.failure)throw this.failure;this.finished=true;});
    return this.sealPromise;
  }
  expectPeerClose(){
    if(this.failure)throw this.failure;
    if(this.ending||this.pendingMessages||this.active||this.queue.length
      ||(!this.peerCloseExpected&&this.lastCompletedKind!==KINDS.CLOSE_CHILD_INPUT))throw new Error('Expected peer close requires a drained CLOSE_CHILD_INPUT.');
    // Only the owner can send CLOSE_CHILD_INPUT. The worker's stdout stays strict.
    this.peerCloseExpected=true;
  }
}
