import { createBackendEndpoint } from "../ipc/endpoint.js";
import { getRuntimeStatus } from "../modules/runtime/application/get-runtime-status.js";
export function createBackend(ports: Omit<Parameters<typeof createBackendEndpoint>[0], "getStatus">) {
  return createBackendEndpoint({ ...ports, getStatus: () => getRuntimeStatus(Boolean(ports.assistant)) });
}
