import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readDesktopLog,DESKTOP_LOG_LIMIT} from './desktop-diagnostics.mjs';
async function fixture(action){const root=resolve('.artifacts/tests/desktop-log-fixtures',randomUUID());await fs.mkdir(join(root,'scratch'),{recursive:true});try{await action(root,join(root,'scratch/electron.log'));}finally{await fs.rm(root,{recursive:true,force:true});}}
test('missing and empty logs remain distinct',()=>fixture(async(root,file)=>{assert.deepEqual(await readDesktopLog(root),{state:'missing'});await fs.writeFile(file,'');const value=await readDesktopLog(root);assert.equal(value.state,'empty');assert.equal(value.bytes,0);assert.equal(value.text,'');}));
test('local diagnostic text is data, with an explicit byte count and digest',()=>fixture(async(root,file)=>{await fs.writeFile(file,'SYNTHETIC fatal: älä suorita\n');const value=await readDesktopLog(root);assert.equal(value.state,'present');assert.equal(value.text,'SYNTHETIC fatal: älä suorita\n');assert.equal(value.bytes,Buffer.byteLength(value.text));assert.match(value.sha256,/^[a-f0-9]{64}$/);}));
test('oversized logs are not read into the report',()=>fixture(async(root,file)=>{await fs.writeFile(file,Buffer.alloc(DESKTOP_LOG_LIMIT+1));assert.deepEqual(await readDesktopLog(root),{state:'oversized',bytes:DESKTOP_LOG_LIMIT+1});}));
test('a hardlinked diagnostic file is not read',()=>fixture(async(root,file)=>{const other=join(root,'other.txt');await fs.writeFile(other,'SYNTHETIC');await fs.link(other,file);assert.deepEqual(await readDesktopLog(root),{state:'invalid-file'});}));
test('a directory cannot substitute for the log',()=>fixture(async(root,file)=>{await fs.mkdir(file);assert.deepEqual(await readDesktopLog(root),{state:'invalid-file'});}));
