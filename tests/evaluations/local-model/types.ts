export type Case = { id: string; mode: "text" | "json-decision"; weatherScenario: string; promptFi: string;
  history?: { role: "user" | "assistant"; textFi: string }[];
  expectedDecision?: { action: "answer" | "sky.getTarget"; targetId: string; atUtc: string }; expected: string[] };
export type Fixture = { weatherScenarios: Record<string, unknown>; targets: { id: string }[]; atUtc: string; [key: string]: unknown };
