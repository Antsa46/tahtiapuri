import type { AssistantService } from "../modules/assistant/application/assistant-service.js";
import type { DevelopmentService } from "../modules/development/application/development-service.js";
import type { DevelopmentIdentity, DevelopmentInvocation } from "@tahtiapuri/validation/development";
import type { ModelInput } from "@tahtiapuri/validation/assistant";
import { isInitialize, isRequest, type Response, type Ready } from "@tahtiapuri/validation/backend";
import type { RuntimeStatus } from "@tahtiapuri/validation/public";
export function createBackendEndpoint(ports: {
  send(message: Response | Ready): void; stop(): void; getStatus(): RuntimeStatus; now(): number; assistant?: AssistantService; development: DevelopmentService;
}) {
  let session: string | undefined;
  let closing = false;
  const development = ports.development;
  const recentIds = new Set<string>();
  return {
    receive(message: unknown): boolean {
      if (closing) return false;
      if (session === undefined) {
        if (!isInitialize(message)) return false;
        session = message.session;
        ports.send({ type: "ready", protocol: 1, session });
        return true;
      }
      if (!isRequest(message, session, ports.now()) || recentIds.has(message.id)) return false;
      recentIds.add(message.id);
      if (recentIds.size > 256) recentIds.delete(recentIds.values().next().value!);
      if (message.operation === "runtime.shutdown") { closing = true; development.configure(null); }
      const operation = message.operation;
      const result = operation === "runtime.status" ? ports.getStatus()
        : operation === "assistant.submit" ? (ports.assistant?.submit(message.input as ModelInput) ?? { ok: false as const, code: "ENGINE_UNAVAILABLE" as const })
        : operation === "assistant.get" ? (ports.assistant?.get(message.input as string) ?? { ok: false as const, code: "ENGINE_UNAVAILABLE" as const })
        : operation === "assistant.cancel" ? (ports.assistant?.cancel(message.input as string) ?? { ok: false as const, code: "ENGINE_UNAVAILABLE" as const })
        : operation === "development.status" ? development.status()
        : operation === "development.configure" ? development.configure(message.input as string | null)
        : operation === "development.attach" ? development.attach(message.input as DevelopmentIdentity)
        : operation === "development.detach" ? development.detach(message.input as DevelopmentIdentity)
        : operation === "development.invoke" ? development.invoke(message.input as DevelopmentInvocation) : null;
      ports.send({ type: "response", protocol: 1, session, id: message.id, operation, result });
      if (closing) ports.stop();
      return true;
    },
  };
}
