import assert from 'node:assert/strict';
export const registryReadSid='S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681';
export function validateCapabilityPolicy(row,mode,policy){
  assert(['none','registryRead'].includes(policy));
  if(policy==='registryRead'){
    assert.equal(mode,'lpac');assert.equal(row.capabilities,1);
    assert.deepEqual(row.capabilitySids,[{sid:registryReadSid,attributes:4}]);
  }else{
    assert.equal(row.capabilities,0);
    // Old zero-capability receipts remain replayable; new receipts carry the set.
    if(Object.hasOwn(row,'capabilitySids'))assert.deepEqual(row.capabilitySids,[]);
  }
  if(Object.hasOwn(row,'capabilityPolicy'))assert.equal(row.capabilityPolicy,policy);
  // The exact permitted set contains no network capability. This is token
  // evidence only, not proof that network attempts are blocked.
  return {capabilityPolicy:policy,networkCapabilityCount:0};
}
