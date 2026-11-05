// Fixed synthetic inputs. This contract grants no executable, path or network authority.
export const ADVERSE_CASE_IDS=Object.freeze([
  'owner-eof-model-pending',
  'owner-header20-eof-before-start',
  'owner-app65537-header-before-start',
  'sky-output-pause-kill',
]);
export const PENDING_MODEL_PROMPT='SYNTHETIC PENDING OWNER';
export const SKY_REQUEST_INPUT=Object.freeze({
  atUtc:'2026-01-01T00:00:00.000Z',timeZone:'UTC',
  observer:Object.freeze({latitudeDeg:0,longitudeDeg:0,elevationMeters:0}),
});
export const CHILD_ABSENCE_BUDGET_MS=1500;
