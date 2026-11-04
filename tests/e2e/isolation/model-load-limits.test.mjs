import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePreparationLimits} from './model-load-limits.mjs';
const valid = () => ({pid: 123, affinity: 1, priority: 'BelowNormal'});
test('accepts the actual driver identity with both required OS limits', () => {
  assert.deepEqual(validatePreparationLimits(valid(), 123), valid());
});
for (const [name, mutate] of [
  ['different process', x => x.pid = 124],
  ['multiple processors', x => x.affinity = 3],
  ['missing affinity', x => delete x.affinity],
  ['normal priority', x => x.priority = 'Normal'],
  ['missing priority', x => delete x.priority],
  ['string affinity', x => x.affinity = '1'],
  ['extra approval field', x => x.approved = true],
]) test(`rejects ${name}`, () => {
  const value = valid(); mutate(value);
  assert.throws(() => validatePreparationLimits(value, 123));
});
