import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {readGgufFileInfo} from 'node-llama-cpp';
import {collect,bounded} from './process-harness.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
const limits=verifyPreparationLimits(),output='.artifacts/tests/isolation/application-prompt';
const folder=join(output,'runs',randomUUID());await mkdir(folder,{recursive:true});
const summary={schema:1,modelLoaded:false,passed:false,limits,cases:[]};
let child,report;
try {
  const build=JSON.parse(await readFile(join(output,'native/build-manifest.json'),'utf8'));
  assert.equal(build.schema,1);assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');
  const expected=['tests/e2e/isolation/native/application-prompt-tests.cpp','apps/model-runtime/native/prompt.h','apps/model-runtime/native/protocol.h',
    'packages/windows-runtime/native/common.h','packages/windows-runtime/native/transport-wire.h','.artifacts/tests/isolation/application-prompt/native/bin/application-prompt-tests.exe'];
  assert.deepEqual(build.files.map(x=>x.path).sort(),expected.sort());
  for(const entry of build.files)assert.equal(createHash('sha256').update(await readFile(entry.path)).digest('hex'),entry.sha256);
  summary.build=build;
  const info=await readGgufFileInfo('.local/models/Qwen3-4B-Q4_K_M.gguf');
  const source=info.metadata.tokenizer.chat_template;
  assert.equal(createHash('sha256').update(source).digest('hex'),'57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361');
  const require=createRequire(import.meta.resolve('node-llama-cpp'));
  const {Template}=await import(pathToFileURL(require.resolve('@huggingface/jinja')).href);
  const template=new Template(source);
  child=spawn(resolve(output,'native/bin/application-prompt-tests.exe'),[],{stdio:['pipe','pipe','pipe'],windowsHide:true});report=collect(child);
  assert.deepEqual(await bounded(report.exited,10000,'Prompt test timed out'),{code:0,signal:null});report.checkComplete();assert.equal(report.stderr,'');
  assert.equal(report.records.length,9);assert.deepEqual(report.records.at(-1),{type:'prompt-tests',passed:true,cases:8});
  for(const row of report.records.slice(0,-1)){
    assert.deepEqual(Object.keys(row).sort(),['case','formattedHex','systemHex','type','userHex']);assert.equal(row.type,'prompt-test');
    const system=Buffer.from(row.systemHex,'hex').toString('utf8'),user=Buffer.from(row.userHex,'hex').toString('utf8');
    const expected=template.render({messages:[{role:'system',content:system},{role:'user',content:user}],add_generation_prompt:true,enable_thinking:false});
    assert.equal(Buffer.from(expected).toString('hex'),row.formattedHex);
    summary.cases.push({case:row.case,templateEquivalent:true});
  }
  summary.passed=true;
} catch(error){summary.failure=error.message;process.exitCode=1;}
finally {
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();await bounded(report.exited,5000,'Prompt process did not exit');
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();summary.records=report.records;summary.stderr=report.stderr;}
  await writeFile(join(folder,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({passed:summary.passed,cases:summary.cases.length,modelLoaded:false,report:join(folder,'summary.json')}));
}
