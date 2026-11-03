import { DevelopmentService } from "../modules/development/application/development-service.js";
import { createBackendEndpoint } from "../ipc/endpoint.js";
import { getRuntimeStatus } from "../modules/runtime/application/get-runtime-status.js";
export function createBackend(ports: Omit<Parameters<typeof createBackendEndpoint>[0], "getStatus" | "development">) {
  return createBackendEndpoint({ ...ports, development: new DevelopmentService(ports.assistant), getStatus: () => getRuntimeStatus(Boolean(ports.assistant)) });
}
