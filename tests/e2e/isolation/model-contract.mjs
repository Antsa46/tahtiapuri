import assert from 'node:assert/strict';
export const modelProfile = Object.freeze({id:'qwen3-4b-q4-k-m',file:'model.gguf',bytes:2497280256,sha256:'7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',templateSha256:'57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361'});
export const modelOptions = Object.freeze({gpuLayers:0,vocabOnly:false,useMmap:true,useMlock:false,checkTensors:false,lazyMode:false});
export function validateModelProfile(value) { assert.deepEqual(value, modelProfile, 'Only the pinned 4B profile is allowed.'); }
export function validateModelSelection(runtime, mode, kind) {
  assert.equal(runtime,'local-patched');assert(['control','lpac'].includes(mode));
  assert(['normal','missing-model','owner-loaded'].includes(kind));
}
