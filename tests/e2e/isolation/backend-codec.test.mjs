import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {setImmediate as turn} from 'node:timers/promises';
import {HEADER,KINDS,FrameReader,frame,encodeJson,decodeJson,BoundedWriter} from './backend-codec.mjs';

const nonce='a'.repeat(64),options={nonce,allowedKinds:[KINDS.APP],maxPayloadBytes:65536,maxFrames:256,maxTotalBytes:4*1024*1024+256*HEADER};
const reader=patch=>new FrameReader({...options,...patch});
const encoded=(sequence=1,body=Buffer.from('tähti'))=>frame(KINDS.APP,sequence,nonce,body);
const writerOptions=patch=>({...options,maxPendingMessages:32,maxPendingBytes:1024*1024,...patch});
class HeldStream extends EventEmitter{
  writes=[];callbacks=[];writableEnded=false;destroyed=false;backpressure=false;
  write(bytes,callback){this.writes.push(Buffer.from(bytes));this.callbacks.push(callback);return !this.backpressure;}
  release(error){this.callbacks.shift()?.(error);}
  end(callback){this.writableEnded=true;queueMicrotask(()=>{callback?.();this.emit('finish');this.emit('close');});}
}

test('TBIP fragments and coalesces frames with exact independent sequences and Unicode bytes',()=>{
  const input=reader(),responses=[];for(const byte of encoded())responses.push(...input.push(Buffer.from([byte])));
  responses.push(...input.push(Buffer.concat([encoded(2),encoded(3)])));
  assert.deepEqual(responses.map(row=>[row.kind,row.sequence,row.body.toString('utf8')]),[[2,1,'tähti'],[2,2,'tähti'],[2,3,'tähti']]);input.finish();
  assert.throws(()=>input.push(encoded(4)));assert.throws(()=>input.push(Buffer.alloc(0)));
});

for(const [label,mutate]of[
  ['magic',bytes=>bytes[0]^=128],['version',bytes=>bytes.writeUInt16LE(2,4)],
  ['nonce',bytes=>bytes[16]^=1],['unknown kind',bytes=>bytes.writeUInt16LE(999,6)],
  ['forbidden kind',bytes=>bytes.writeUInt16LE(KINDS.KILL,6)],['zero sequence',bytes=>bytes.writeUInt32LE(0,8)],
  ['skipped initial sequence',bytes=>bytes.writeUInt32LE(2,8)],['oversized declared body',bytes=>bytes.writeUInt32LE(65537,12)]
])test('TBIP rejects '+label+' before allocating a payload and stays failed',()=>{
  const input=reader(),bytes=encoded();mutate(bytes);
  assert.throws(()=>input.push(bytes.subarray(0,HEADER)));assert.equal(input.body,undefined);
  assert.throws(()=>input.push(encoded()));assert.throws(()=>input.finish());
});

test('TBIP rejects duplicate and skipped sequences after a valid frame',()=>{
  for(const sequence of [1,3]){const input=reader();input.push(encoded());assert.throws(()=>input.push(encoded(sequence)));}
});
for(const length of [1,47,48,50])test('TBIP rejects truncated EOF at byte '+length+' permanently',()=>{
  const input=reader();input.push(encoded().subarray(0,length));assert.throws(()=>input.finish());assert.throws(()=>input.push(encoded()));
});
test('TBIP counts headers in total budgets and rejects excess counts and non-byte input',()=>{
  const exact=reader({maxFrames:1,maxTotalBytes:HEADER+1,maxPayloadBytes:1});
  assert.equal(exact.push(encoded(1,Buffer.from('x'))).length,1);exact.finish();
  const count=reader({maxFrames:1});count.push(encoded());assert.throws(()=>count.push(encoded(2)));
  const total=reader({maxTotalBytes:HEADER});assert.throws(()=>total.push(encoded().subarray(0,HEADER)));assert.equal(total.body,undefined);
  assert.throws(()=>reader().push('bytes'));
  assert.throws(()=>frame(KINDS.APP,0,nonce,Buffer.alloc(0)));assert.throws(()=>frame(999,1,nonce,Buffer.alloc(0)));
});
test('TBIP assembles one maximum 16 MiB response with linear fragment copies',()=>{
  const body=Buffer.alloc(16*1024*1024,88),bytes=encoded(1,body);
  const input=reader({maxPayloadBytes:body.length,maxTotalBytes:bytes.length,maxFrames:1});let records=[];
  for(let offset=0;offset<bytes.length;offset+=4096){const next=input.push(bytes.subarray(offset,offset+4096));if(next.length)records=next;}
  input.finish();assert.equal(records.length,1);assert.deepEqual(records[0].body,body);
});

test('JSON budgets count UTF-8 bytes and escaped lone surrogates; decoding is fatal',()=>{
  const value={text:'tähti\ud800'},encoded=encodeJson(value,100);assert.deepEqual(decodeJson(encoded),value);
  assert(encoded.includes(Buffer.from('\\ud800')));assert.throws(()=>encodeJson(value,encoded.length-1));
  assert.throws(()=>encodeJson(undefined,100));assert.throws(()=>decodeJson('text'));
  for(const bytes of [Buffer.from([255]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0xe2,0x82]),Buffer.from('\ufeff{}'),Buffer.from('{')])assert.throws(()=>decodeJson(bytes));
});

test('writer freezes queued bodies, assigns sequences on serialized writes and drains before ending',async()=>{
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions()),body=Buffer.from('a');
  const first=writer.send(KINDS.APP,body),second=writer.send(KINDS.APP,Buffer.from('b'));body[0]=120;
  assert.equal(stream.writes.length,1);let drained=false;const pending=writer.drain().then(()=>{drained=true;});
  stream.release();await first;await turn();assert.equal(drained,false);assert.equal(stream.writes.length,2);
  stream.release();await second;await pending;await writer.end();assert.equal(stream.writableEnded,true);
  const input=reader(),records=input.push(Buffer.concat(stream.writes));input.finish();
  assert.deepEqual(records.map(row=>[row.sequence,row.body.toString()]),[[1,'a'],[2,'b']]);
});
test('writer waits for both the write callback and drain after backpressure',async()=>{
  for(const drainFirst of [false,true]){
    const stream=new HeldStream();stream.backpressure=true;const writer=new BoundedWriter(stream,writerOptions());
    let completed=false;const send=writer.send(KINDS.APP,Buffer.from('x')).then(()=>{completed=true;});
    if(drainFirst)stream.emit('drain');else stream.release();await turn();assert.equal(completed,false);
    if(drainFirst)stream.release();else stream.emit('drain');await send;await writer.end();
  }
});
test('writer also handles a real Writable with a small high-water mark',async()=>{
  const writes=[],stream=new Writable({highWaterMark:1,write(bytes,encoding,callback){writes.push(Buffer.from(bytes));queueMicrotask(callback);}});
  const writer=new BoundedWriter(stream,writerOptions());await Promise.all([writer.send(KINDS.APP,Buffer.from('a')),writer.send(KINDS.APP,Buffer.from('b'))]);await writer.end();
  assert.equal(reader().push(Buffer.concat(writes)).length,2);
});
test('writer message and byte queues include the active frame; overflow permanently rejects all work',async()=>{
  for(const patch of [{maxPendingMessages:2},{maxPendingBytes:2*(HEADER+1)}]){
    const stream=new HeldStream(),failures=[],writer=new BoundedWriter(stream,writerOptions({...patch,onFailure:error=>failures.push(error)}));
    const attempts=[writer.send(KINDS.APP,Buffer.from('a')),writer.send(KINDS.APP,Buffer.from('b')),writer.send(KINDS.APP,Buffer.from('c'))];
    assert((await Promise.allSettled(attempts)).every(row=>row.status==='rejected'));
    await assert.rejects(writer.drain());await assert.rejects(writer.end());await assert.rejects(writer.send(KINDS.APP,Buffer.from('d')));
    assert.equal(failures.length,1);assert.equal(stream.writes.length,1);stream.release();
  }
});
test('writer rejects oversized bodies, forbidden kinds and complete-wire aggregate caps',async()=>{
  for(const patch of [{maxFrames:1},{maxTotalBytes:HEADER+1}]){
    const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions(patch));
    const first=writer.send(KINDS.APP,Buffer.from('a'));stream.release();await first;
    await assert.rejects(writer.send(KINDS.APP,Buffer.from('b')));
  }
  for(const [kind,body]of [[KINDS.KILL,Buffer.alloc(0)],[KINDS.APP,Buffer.alloc(65537)]]){
    const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions());await assert.rejects(writer.send(kind,body));assert.equal(stream.writes.length,0);
  }
});
test('asynchronous stream error or premature close rejects active, queued, drain and end promises',async()=>{
  for(const event of ['error','close']){
    const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions());
    const promises=[writer.send(KINDS.APP,Buffer.from('a')),writer.send(KINDS.APP,Buffer.from('b')),writer.drain(),writer.end()];
    stream.emit(event,new Error('synthetic stream error'));
    assert((await Promise.allSettled(promises)).every(row=>row.status==='rejected'));stream.release();await turn();assert.equal(stream.writes.length,1);
  }
});
test('end freezes admission and an end callback error remains a permanent failure',async()=>{
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions());
  const end=writer.end();const rejected=writer.send(KINDS.APP,Buffer.alloc(0));await assert.rejects(rejected);await assert.rejects(end);
  const bad=new HeldStream();bad.end=callback=>queueMicrotask(()=>callback(new Error('synthetic final failure')));
  const broken=new BoundedWriter(bad,writerOptions());await assert.rejects(broken.end());await assert.rejects(broken.drain());
});
test('seal drains output and permits peer close while retaining the open owner input',async()=>{
  const stream=new HeldStream(),failures=[],writer=new BoundedWriter(stream,writerOptions({onFailure:error=>failures.push(error)}));
  const send=writer.send(KINDS.APP,Buffer.from('x'));let sealed=false;const seal=writer.seal().then(()=>{sealed=true;});
  await turn();assert.equal(sealed,false);assert.equal(stream.writableEnded,false);
  stream.release();await send;await seal;assert.equal(stream.writableEnded,false);
  stream.emit('close');assert.equal(failures.length,0);await writer.drain();
  await assert.rejects(writer.send(KINDS.APP,Buffer.alloc(0)));assert.equal(stream.writes.length,1);
});
test('seal does not hide incomplete output or premature peer closure',async()=>{
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions());
  const pending=writer.send(KINDS.APP,Buffer.from('x')),sealed=writer.seal();stream.emit('close');
  assert((await Promise.allSettled([pending,sealed])).every(row=>row.status==='rejected'));
  assert.equal(stream.writableEnded,false);stream.release();
});
test('owner can expect peer close only after its ordered CLOSE_CHILD_INPUT is fully drained',async()=>{
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions({allowedKinds:[KINDS.APP,KINDS.CLOSE_CHILD_INPUT,KINDS.KILL]}));
  assert.throws(()=>writer.expectPeerClose());
  const app=writer.send(KINDS.APP,Buffer.from('x'));stream.release();await app;assert.throws(()=>writer.expectPeerClose());
  const close=writer.send(KINDS.CLOSE_CHILD_INPUT,Buffer.alloc(0));assert.throws(()=>writer.expectPeerClose());
  stream.release();await close;writer.expectPeerClose();assert.equal(stream.writableEnded,false);
  stream.emit('close');await writer.seal();await writer.drain();assert.equal(stream.writableEnded,false);
});
test('owner peer-close expectation keeps KILL usable while the pipe is still open',async()=>{
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions({allowedKinds:[KINDS.CLOSE_CHILD_INPUT,KINDS.KILL]}));
  const close=writer.send(KINDS.CLOSE_CHILD_INPUT,Buffer.alloc(0));stream.release();await close;writer.expectPeerClose();
  const kill=writer.send(KINDS.KILL,Buffer.alloc(0));stream.release();await kill;
  const input=new FrameReader({...options,allowedKinds:[KINDS.CLOSE_CHILD_INPUT,KINDS.KILL]});
  assert.deepEqual(input.push(Buffer.concat(stream.writes)).map(row=>[row.kind,row.sequence]),[[3,1],[4,2]]);input.finish();
  stream.emit('close');await writer.seal();assert.equal(stream.writableEnded,false);
});
test('unarmed close and close with a pending owner write remain fatal',async()=>{
  const unarmedStream=new HeldStream(),unarmed=new BoundedWriter(unarmedStream,writerOptions());
  unarmedStream.emit('close');await assert.rejects(unarmed.drain());assert.throws(()=>unarmed.expectPeerClose());
  const stream=new HeldStream(),writer=new BoundedWriter(stream,writerOptions({allowedKinds:[KINDS.CLOSE_CHILD_INPUT,KINDS.KILL]}));
  const close=writer.send(KINDS.CLOSE_CHILD_INPUT,Buffer.alloc(0));stream.release();await close;writer.expectPeerClose();
  const kill=writer.send(KINDS.KILL,Buffer.alloc(0));stream.emit('close');await assert.rejects(kill);await assert.rejects(writer.seal());
  assert.equal(stream.writableEnded,false);stream.release();
});
