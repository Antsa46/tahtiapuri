import assert from 'node:assert/strict';

// Narrow decoder for the recorded self-relative WFP user-condition profile.
// Validates byte structure only; it does not perform AccessCheck or grant access.
export function validateFilterDescriptor(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 20 && bytes.length <= 65536, 'Invalid descriptor size.');
  assert.equal(bytes[0], 1, 'Descriptor revision.'); assert.equal(bytes[1], 0);
  assert.equal(bytes.readUInt16LE(2), 0x8004, 'Unreviewed descriptor flags.'); // SELF_RELATIVE | DACL_PRESENT
  assert.equal(bytes.readUInt32LE(12), 0, 'Unreviewed SACL.');
  const ranges = [[0, 20]];
  const span = (offset, length) => {
    assert(offset >= 20 && offset % 4 === 0 && length >= 0 && offset + length <= bytes.length, 'Descriptor bounds.');
    assert(ranges.every(([a, b]) => offset + length <= a || offset >= b), 'Overlapping descriptor fields.');
    ranges.push([offset, offset + length]);
  };
  const sidLength = (offset, limit) => {
    assert(offset + 8 <= limit && bytes[offset] === 1 && bytes[offset + 1] <= 15, 'Invalid SID header.');
    const length = 8 + 4 * bytes[offset + 1]; assert(offset + length <= limit, 'Truncated SID.'); return length;
  };
  for (const position of [4, 8]) {
    const offset = bytes.readUInt32LE(position);
    if (offset) { assert(offset >= 20 && offset % 4 === 0 && offset < bytes.length); span(offset, sidLength(offset, bytes.length)); }
  }
  const dacl = bytes.readUInt32LE(16);
  assert(dacl >= 20 && dacl + 8 <= bytes.length, 'Missing DACL.');
  assert.equal(bytes[dacl], 2, 'Unreviewed ACL revision.'); assert.equal(bytes[dacl + 1], 0); assert.equal(bytes.readUInt16LE(dacl + 6), 0);
  const length = bytes.readUInt16LE(dacl + 2), count = bytes.readUInt16LE(dacl + 4);
  assert(length >= 8 && length % 4 === 0 && count > 0 && count <= 256, 'Invalid ACL bounds.');
  span(dacl, length);
  let cursor = dacl + 8;
  for (let i = 0; i < count; i++) {
    assert(cursor + 16 <= dacl + length, 'Truncated ACE.');
    assert.equal(bytes[cursor], 0, 'Unreviewed ACE type.'); assert.equal(bytes[cursor + 1], 0, 'Unreviewed ACE flags.');
    const size = bytes.readUInt16LE(cursor + 2);
    assert(size >= 16 && size % 4 === 0 && cursor + size <= dacl + length, 'Invalid ACE bounds.');
    assert.equal(bytes.readUInt32LE(cursor + 4), 1, 'Unreviewed filter-match access mask.');
    assert.equal(8 + sidLength(cursor + 8, cursor + size), size, 'Unexpected ACE data.');
    cursor += size;
  }
  assert.equal(cursor, dacl + length, 'Unreviewed ACL trailing data.');
  ranges.sort((a, b) => a[0] - b[0]);
  assert(ranges.every(([start], i) => i === 0 || start === ranges[i - 1][1]), 'Unreviewed descriptor padding.');
  assert.equal(ranges.at(-1)[1], bytes.length, 'Unreviewed descriptor trailing data.');
}
