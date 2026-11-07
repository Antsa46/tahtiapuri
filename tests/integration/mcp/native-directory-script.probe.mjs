/** Reviewed-recipe-only attestation and Node snapshots. No process/Worker
 * launch, arbitrary path, mutation of fixtures, or quarantine access here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, lstat, readdir, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = process.env.TAHTIAPURI_DIRECTORY_SCRIPT_RUN_ROOT;
const approvalHash = process.env.TAHTIAPURI_DIRECTORY_APPROVAL_SHA256;
const mode = process.argv[2];
assert(process.platform === "win32" && root && resolve(root) === root);
assert.equal(dirname(root), join(project, ".artifacts/tests/native-directory-script"));
assert.match(basename(root), /^run-[a-f0-9]{32}$/);
assert(["attest", "before", "after"].includes(mode) && process.argv.length === 3);
assert.match(approvalHash ?? "", /^[a-f0-9]{64}$/);
const began = performance.now(), deadline = began + 10000, sha = bytes => createHash("sha256").update(bytes).digest("hex");
const alive = () => assert(performance.now() < deadline, "Original Node observation deadline expired");
async function local(path, file = false) {
  for (let current = path, first = true;; first = false) {
    alive(); const s = await lstat(current); alive();
    assert(!s.isSymbolicLink() && (first && file ? s.isFile() && s.nlink === 1 : s.isDirectory()));
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function read(path, maximum) {
  await local(path, true); alive(); const file = await open(path, "r");
  try {
    alive(); const before = await file.stat(); alive(); assert(before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(before.size + 1); let used = 0;
    while (used < bytes.length) { alive(); const part = await file.read(bytes, used, bytes.length-used, used); alive(); if (!part.bytesRead) break; used += part.bytesRead; }
    const after = await file.stat(); alive(); for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]) assert.equal(before[key], after[key]);
    assert.equal(used, before.size); return bytes.subarray(0, used);
  } finally { await file.close(); }
}
async function fresh(name, value) {
  alive(); await local(root); alive();
  await writeFile(join(root, name), JSON.stringify(value, null, 2)+"\n", { flag: "wx" }); alive();
}
const cases = ["valid-new", "valid-existing", "eof-0", "eof-1", "eof-2", "eof-3", "eof-4", "eof-5", "eof-6", "eof-7", "wrong", "trailing", "hold", "leaf-acl", "parent-acl", "missing-parent", "file-leaf", "leaf-junction", "parent-junction"];
const modules = ["native-launch-worker.js", "native-launch-worker-core.js", "native-launch-worker-config.js", "native-launch-gate.js", "native-recovery-grant.js", "native-directory-grant.js"];
await local(root);
const approvedBytes = await read(join(root, "approval.json"), 16384); assert.equal(sha(approvedBytes), approvalHash);
const approved = JSON.parse(approvedBytes.toString("utf8"));
assert.deepEqual(Object.keys(approved).sort(), ["compiled", "schema", "scriptDataSha256"]); assert.equal(approved.schema, 1);
assert.deepEqual(Object.keys(approved.compiled).sort(), [...modules].sort()); assert.match(approved.scriptDataSha256, /^[a-f0-9]{64}$/);
for (const name of modules) {
  const pin = approved.compiled[name]; assert.deepEqual(Object.keys(pin).sort(), ["bytes", "sha256"]);
  const bytes = await read(join(project, "apps/desktop/dist/main", name), 131072);
  assert.equal(bytes.length, pin.bytes); assert.equal(sha(bytes), pin.sha256);
}
const scriptBytes = await read(join(root, "script-data.json"), 32768); assert.equal(sha(scriptBytes), approved.scriptDataSha256);
const data = JSON.parse(scriptBytes.toString("utf8")); assert.deepEqual(Object.keys(data).sort(), ["grantHex", "schema", "script"]);
assert.equal(data.schema, 1); assert.equal(data.grantHex, "5448444952303031");
// Verified before import; trusted same-user/admin code replacement is inside
// Main's program trust boundary, not prevented by these read-only hash checks.
const compiled = await import("../../../apps/desktop/dist/main/native-directory-grant.js"); alive();
assert.equal(compiled.NATIVE_DIRECTORY_SCRIPT, data.script);
assert.equal(compiled.createNativeDirectoryGrant().toString("hex"), data.grantHex);
if (mode === "attest") {
  await fresh("compiled-verification.json", { schema: 1, passed: true, compiled: approved.compiled,
    scriptDataSha256: approved.scriptDataSha256, scriptUtf8Sha256: sha(Buffer.from(data.script)), grantHex: data.grantHex,
    source: "Independently approved six compiled modules; exact imported script/grant bytes", actorExecuted: false });
} else {
  const records = {};
  async function snapshot(rel) {
    const parts = rel.split("/"); let path = root;
    for (let i=0;i<parts.length;++i) {
      path = join(path, parts[i]); alive(); let s;
      try { s = await lstat(path, { bigint: true }); }
      catch(error) { if (error?.code === "ENOENT") return { absent: true }; throw error; }
      alive(); const last = i === parts.length-1;
      if (!last && (s.isSymbolicLink() || !s.isDirectory())) return { blockedBy: relative(root,path).split(sep).join("/"), kind: s.isSymbolicLink() ? "link" : "file" };
      if (last) {
        const value = { dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs), nlink: String(s.nlink),
          kind: s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "file" };
        if (value.kind === "directory") { alive(); value.entries=(await readdir(path)).sort(); alive(); }
        else if (value.kind === "file") { const bytes=await read(path, 1024); value.size=bytes.length; value.sha256=sha(bytes); }
        return value;
      }
    }
  }
  for (let i=0;i<cases.length;++i) {
    const prefix="case-"+String(i+1).padStart(2,"0");
    for (const suffix of ["parent", "parent/control", "parent/control/canary.bin", "target", "target/canary.bin"]) records[prefix+"/"+suffix]=await snapshot(prefix+"/"+suffix);
  }
  if (mode === "before") await fresh("node-before.json", { schema: 1, records });
  else {
    const before=JSON.parse((await read(join(root,"node-before.json"),131072)).toString("utf8")); assert.equal(before.schema,1);
    assert.deepEqual(Object.keys(records),Object.keys(before.records));
    for (const [key,value] of Object.entries(records)) {
      if (key === "case-01/parent") assert.deepEqual(value,{...before.records[key],entries:["control"]});
      else if (key === "case-01/parent/control") { assert.deepEqual(before.records[key],{absent:true}); assert.equal(value.kind,"directory"); assert.deepEqual(value.entries,[]); assert.notEqual(value.ino,"0"); }
      else assert.deepEqual(value,before.records[key],"Original fixture identity/content changed: "+key);
    }
    for (let i=0;i<cases.length;++i) {
      const result=JSON.parse((await read(join(root,"case-"+String(i+1).padStart(2,"0"),"case-result.json"),131072)).toString("utf8"));
      assert.equal(result.case,cases[i]);assert.equal(result.passed,true);assert.equal(result.actualExitObserved,true);assert.equal(result.streamsDone,true);
    }
    await fresh("node-after.json", { schema: 1, passed:true, records, scope:"All 19 original fixture identities/content, before junction unlink; actual ACLs/stdio in each independent case receipt" });
  }
}
