import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correlationFixture } from './etw-correlation.fixture.mjs';
import { socketDenialFixture } from './etw-socket-denial.fixture.mjs';
import { candidateFixture } from './etw-candidate.fixture.mjs';
import { replayEtwRun } from './replay-etw.mjs';
async function savedFixture(t, kind = 'normal', candidate=false, socketDenied=false) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.artifacts/tests/etw-replay');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'synthetic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { cases, evidence } = socketDenied?socketDenialFixture():candidate?candidateFixture():correlationFixture(kind), contents = new Map();
  for (const c of cases) contents.set(`${c.caseLabel??`${c.mode}-${c.kind}`}/result.json`, JSON.stringify(c));
  contents.set('etw/done.json', JSON.stringify(evidence.done)); contents.set('etw/guard-done.json', JSON.stringify(evidence.guard));
  contents.set('etw/events.jsonl', evidence.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const [name, text] of contents) { await fs.mkdir(dirname(join(root, name)), { recursive: true }); await fs.writeFile(join(root, name), text); }
  return { root, contents };
}
test('replays saved evidence without changing any original bytes', async t => {
  const { root, contents } = await savedFixture(t), result = await replayEtwRun(root);
  assert.equal(result.networkVerified, true); assert.equal(result.eventCount, 12); assert.equal(result.fullIsolationVerified, false);
  for (const [name, text] of contents) assert.equal(await fs.readFile(join(root, name), 'utf8'), text);
});
test('missing after-control file cannot yield acceptance', async t => {
  const { root } = await savedFixture(t); await fs.unlink(join(root, 'control-inherit-normal/result.json'));
  await assert.rejects(replayEtwRun(root));
});
test('truncated event log cannot yield acceptance', async t => {
  const { root, contents } = await savedFixture(t); await fs.writeFile(join(root, 'etw/events.jsonl'), contents.get('etw/events.jsonl').trimEnd());
  await assert.rejects(replayEtwRun(root));
});

for (const kind of ['error','launcher-kill','owner-kill']) test(`replays only the explicitly named ${kind} variation without changing source files`, async t => {
  const { root, contents } = await savedFixture(t, kind);
  assert.equal((await replayEtwRun(root, kind)).lifecycleKind, kind);
  await assert.rejects(replayEtwRun(root));
  for (const [name, text] of contents) assert.equal(await fs.readFile(join(root, name), 'utf8'), text);
});
test('replay rejects arbitrary case paths', async () => { await assert.rejects(replayEtwRun('unused', '../elsewhere')); });

test('candidate replay uses only the explicitly selected profile and preserves all bytes', async t => {
  const {root,contents}=await savedFixture(t,'normal',true);
  const result=await replayEtwRun(root,'normal',{profile:'lpac-registry-read'});
  assert.equal(result.networkVerified,true);assert.equal(result.experimentProfile,'lpac-registry-read');
  await assert.rejects(replayEtwRun(root));
  for(const [name,text] of contents)assert.equal(await fs.readFile(join(root,name),'utf8'),text);
});
test('candidate replay cannot substitute the original AC case', async t => {
  const {root}=await savedFixture(t);
  await assert.rejects(replayEtwRun(root,'normal',{profile:'lpac-registry-read'}));
});
test('replay rejects arbitrary profile paths before file access', async () => {
  await assert.rejects(replayEtwRun('unused','normal',{profile:'../elsewhere'}));
});

test('saved socket denial requires the explicit method and never rewrites the original result', async t => {
 const {root,contents}=await savedFixture(t,'normal',true,true);
 await assert.rejects(replayEtwRun(root,'normal',{profile:'lpac-registry-read'}));
 const r=await replayEtwRun(root,'normal',{profile:'lpac-registry-read',method:'socket-access-denied'});
 assert.equal(r.socketCreationBlocked,true);assert.equal(r.packetDropVerified,false);
 for(const [name,text] of contents)assert.equal(await fs.readFile(join(root,name),'utf8'),text);
});
