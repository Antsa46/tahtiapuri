import assert from 'node:assert/strict';
export const contextOptions = Object.freeze({contextSize:512,sequences:1,batchSize:32,threads:1,flashAttention:false});
export const inferenceOptions = Object.freeze({maxTokens:16,temperature:0,seed:42,reasoning:false});
export const inferenceInput = Object.freeze({systemPrompt:'Vastaa lyhyesti suomeksi.',prompt:'Kerro lyhyesti miksi tähdet näkyvät yöllä.'});
export function validateInferenceSelection(mode,kind){assert(['control','lpac'].includes(mode));assert(['normal','cancel','owner-context'].includes(kind));}
export function loadKind(kind){assert(['normal','cancel','owner-context'].includes(kind));return kind==='owner-context'?'owner-loaded':'normal';}
