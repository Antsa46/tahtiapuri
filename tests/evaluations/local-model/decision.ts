export type Decision = { action: "answer" | "sky.getTarget"; targetId: string; atUtc: string; text: string };
export function assessDecision(text: string, targetIds: string[], atUtc: string, expected?: Omit<Decision, "text">) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { json: false, schema: false, semantics: false, tool: false, arguments: false }; }
  const v = value as Record<string, unknown> | null;
  const schema = Boolean(v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).sort().join(",") === "action,atUtc,targetId,text"
    && ["answer", "sky.getTarget"].includes(v.action as string)
    && ["targetId", "atUtc", "text"].every(k => typeof v[k] === "string"));
  if (!schema) return { json: true, schema: false, semantics: false, tool: false, arguments: false };
  const d = value as Decision;
  const semantics = d.action === "answer" ? d.targetId === "" && d.atUtc === ""
    : targetIds.includes(d.targetId) && d.atUtc === atUtc;
  return { json: true, schema, semantics,
    tool: expected ? d.action === expected.action : null,
    arguments: expected ? d.targetId === expected.targetId && d.atUtc === expected.atUtc : null };
}
