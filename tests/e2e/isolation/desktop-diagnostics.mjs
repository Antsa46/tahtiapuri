import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const DESKTOP_LOG_LIMIT = 256 * 1024;
// Diagnostic content is never an authorization or acceptance receipt.
export async function readDesktopLog(staged) {
 let handle;
 try {
  for(const path of [staged,join(staged,'scratch')]){const value=await fs.lstat(path);if(!value.isDirectory()||value.isSymbolicLink())return {state:'invalid-path'};}
  const path=join(staged,'scratch/electron.log');
  let before;try{before=await fs.lstat(path);}catch(error){if(error.code==='ENOENT')return {state:'missing'};throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)return {state:'invalid-file'};
  if(before.size>DESKTOP_LOG_LIMIT)return {state:'oversized',bytes:before.size};
  handle=await fs.open(path,'r');const opened=await handle.stat();
  if(!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev)return {state:'changed-file'};
  const buffer=Buffer.alloc(DESKTOP_LOG_LIMIT+1);let used=0;
  while(used<buffer.length){const {bytesRead}=await handle.read(buffer,used,buffer.length-used,used);if(!bytesRead)break;used+=bytesRead;}
  if(used>DESKTOP_LOG_LIMIT)return {state:'oversized',bytes:used};
  const bytes=buffer.subarray(0,used);
  return {state:used?'present':'empty',bytes:used,sha256:createHash('sha256').update(bytes).digest('hex'),text:bytes.toString('utf8')};
 }catch(error){return {state:'unavailable',code:error.code??'UNKNOWN'};}
 finally{await handle?.close();}
}
