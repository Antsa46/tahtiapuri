import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFilterDescriptor } from './filter-descriptor.mjs';
import { syntheticDescriptor } from './etw-correlation.fixture.mjs';
test('accepts a synthetic self-relative descriptor without evaluating trustees', () => assert.doesNotThrow(() => validateFilterDescriptor(syntheticDescriptor())));
for (const [name, change] of [
  ['absolute descriptor', b => b.writeUInt16LE(4, 2)],
  ['null DACL', b => b.writeUInt32LE(0, 16)],
  ['unaligned DACL', b => b.writeUInt32LE(21, 16)],
  ['owner overlaps DACL', b => b.writeUInt32LE(36, 4)],
  ['ACL extends past buffer', b => b.writeUInt16LE(100, 22)],
  ['too many ACEs', b => b.writeUInt16LE(2, 24)],
  ['zero ACE size', b => b.writeUInt16LE(0, 30)],
  ['truncated SID', b => { b[37] = 15; }],
  ['unknown ACE type', b => { b[28] = 5; }],
  ['unreviewed rights', b => b.writeUInt32LE(2, 32)],
]) test(`rejects ${name}`, () => { const b = syntheticDescriptor(); change(b); assert.throws(() => validateFilterDescriptor(b)); });
