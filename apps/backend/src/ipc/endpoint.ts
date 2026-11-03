import { isInitialize, isRequest, type Response, type Ready } from "@tahtiapuri/validation/backend";
import type { RuntimeStatus } from "@tahtiapuri/validation/public";

export function createBackendEndpoint(ports: {
  send(message: Response | Ready): void;
  stop(): void;
  getStatus(): RuntimeStatus;
  now(): number;
}) {
  let session: string | undefined;
  let closing = false;
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
      if (message.operation === "runtime.shutdown") closing = true;
      ports.send({
        type: "response", protocol: 1, session, id: message.id,
        operation: message.operation,
        result: message.operation === "runtime.status" ? ports.getStatus() : null,
      });
      if (closing) ports.stop();
      return true;
    },
  };
}
