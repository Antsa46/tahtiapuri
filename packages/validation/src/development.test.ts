import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isBridgeCommand, isConnectionDescription, isDevelopmentInvocation, PIPE_PREFIX } from "./development.js";
import { isRequest, isResponse } from "./backend-protocol.js";
const session = "a".repeat(64), clientId = randomUUID();
it("rejects forged roles, free URLs, oversized prompts and nonlocal pipes", () => {
  const command = { id: randomUUID(), operation: "probe", input: { prompt: "Koe", backend: "cpu" } };
  expect(isBridgeCommand(command)).toBe(true);
  for (const bad of [{ ...command, role: "ui" }, { ...command, operation: "shell.exec" }, { ...command, input: { ...command.input, url: "https://example.invalid" } }, { ...command, input: { ...command.input, prompt: "x".repeat(2001) } }]) expect(isBridgeCommand(bad)).toBe(false);
  expect(isDevelopmentInvocation({ epoch: session, clientId, operation: "probe", input: command.input })).toBe(true);
  expect(isDevelopmentInvocation({ epoch: session, clientId, operation: "enable", input: true })).toBe(false);
  expect(isConnectionDescription({ protocol: 1, pipe: PIPE_PREFIX + "b".repeat(32), token: session })).toBe(true);
  for (const pipe of ["127.0.0.1:1234", "\\\\remote\\pipe\\x", PIPE_PREFIX + "../x"]) expect(isConnectionDescription({ protocol: 1, pipe, token: session })).toBe(false);
});
it("validates privileged controls separately from probes and responses", () => {
  const envelope = { type: "request", protocol: 1, session, id: randomUUID(), expiresAtUnixMs: 200 };
  expect(isRequest({ ...envelope, operation: "development.configure", input: session }, session, 100)).toBe(true);
  expect(isRequest({ ...envelope, operation: "development.configure", input: { enabled: true, role: "ui" } }, session, 100)).toBe(false);
  expect(isRequest({ ...envelope, operation: "development.invoke", input: { epoch: session, clientId, operation: "status", input: null } }, session, 100)).toBe(true);
  expect(isResponse({ type: "response", protocol: 1, session, id: envelope.id, operation: "development.status", result: { ok: true, status: { enabled: false, connected: true, modelId: "qwen3-4b-q4-k-m", engineVersion: "3.22.2", protocolVersion: 1 } } }, session)).toBe(false);
});
