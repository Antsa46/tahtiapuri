// TAIP framing for the fixed synthetic Node probe; no runtime side effects.
import {TextDecoder} from 'node:util';
export const HEADER=48, MAX_PAYLOAD=16384, MAX_FRAMES=20, MAX_BYTES=65536;
export function utf8(bytes) { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); if(text.includes('\0'))throw new Error('NUL'); return text; }
export function encode(op,id,session,body=Buffer.alloc(0)) {
  if(!Buffer.isBuffer(session)||session.length!==32||!Number.isInteger(op)||op<1||op>65535||!Number.isInteger(id)||id<1||id>0xffffffff||body.length>MAX_PAYLOAD)throw new Error('frame');
  const b=Buffer.alloc(HEADER+body.length);b.write('TAIP');b.writeUInt16LE(1,4);b.writeUInt16LE(op,6);b.writeUInt32LE(id,8);b.writeUInt32LE(body.length,12);session.copy(b,16);body.copy(b,HEADER);return b;
}
export class Reader {
  buffer=Buffer.alloc(0); frames=0; bytes=0; last=0; failed=false;
  constructor(session){if(!Buffer.isBuffer(session)||session.length!==32)throw new Error('session');this.session=Buffer.from(session);}
  push(chunk){
    if(this.failed)throw new Error('closed');
    try {
      if(!Buffer.isBuffer(chunk))throw new Error('bytes');
      this.bytes+=chunk.length;if(this.bytes>MAX_BYTES)throw new Error('budget');
      this.buffer=Buffer.concat([this.buffer,chunk]);const result=[];
      while(this.buffer.length>=HEADER){const b=this.buffer,len=b.readUInt32LE(12),id=b.readUInt32LE(8);
        if(!b.subarray(0,4).equals(Buffer.from('TAIP'))||b.readUInt16LE(4)!==1||!b.subarray(16,48).equals(this.session)||len>MAX_PAYLOAD||id<=this.last)throw new Error('header');
        if(b.length<HEADER+len)break;
        if(++this.frames>MAX_FRAMES)throw new Error('frames');
        result.push({op:b.readUInt16LE(6),id,body:Buffer.from(b.subarray(48,48+len))});this.last=id;this.buffer=b.subarray(48+len);
      }return result;
    }catch(e){this.failed=true;throw e;}
  }
  finish(){if(this.failed||this.buffer.length)throw new Error('truncated');}
}
