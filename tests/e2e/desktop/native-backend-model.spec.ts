import { expect, test, type ElectronApplication } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { isPlacesState } from "@tahtiapuri/validation/observing";
import type { PlacesState } from "@tahtiapuri/domain";
import { launch } from "../support/electron.js";
import { addPlace } from "../support/observing.js";

const runtimeRoot = process.env.TAHTIAPURI_TEST_NATIVE_BACKEND_ROOT;
test.skip(!runtimeRoot, "A separately prepared and admitted native backend/model composition is required.");
const prompt = "Vastaa vain yhdellä sanalla: Jupiter";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function directoryTree(path: string): Promise<void> {
  for (let current = path;;) {
    const stat = await lstat(current);
    expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
    expect(relative(current, await realpath(current))).toBe("");
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function freshCase(): Promise<string> {
  // The separately admitted runner creates/checks this private parent first.
  const parent = join(process.cwd(), ".artifacts/tests/native-backend-model");
  await directoryTree(parent);
  const data = join(parent, "run-" + randomBytes(16).toString("hex"));
  await mkdir(data); // No recursive creation or existing-case reuse.
  await directoryTree(data); return data;
}
async function emptyDirectory(path: string): Promise<void> {
  await directoryTree(path); expect(await readdir(path)).toEqual([]);
}
function storage(raw: Buffer): PlacesState {
  expect(raw.length).toBeLessThanOrEqual(32768);
  const value = JSON.parse(raw.toString("utf8")) as { schemaVersion: number; state: PlacesState; sha256: string };
  expect(value.schemaVersion).toBe(1); expect(isPlacesState(value.state)).toBe(true);
  expect(value.sha256).toBe(sha(JSON.stringify(value.state))); return value.state;
}
async function cleanJournal(data: string, digest: string) {
  const raw = await readFile(join(data, "backend-state/control/recovery.journal"));
  expect(raw.length).toBeLessThanOrEqual(4096);
  expect([...raw].every(byte => byte === 10 || byte >= 32 && byte <= 126)).toBe(true);
  const text = raw.toString("ascii"); expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n"); expect(lines).toHaveLength(18);
  expect(lines[0]).toBe("TAHTIAPURI_BACKEND_JOURNAL_V2"); expect(lines[1]).toBe(digest);
  expect(lines[17]).toMatch(/^[a-f0-9]{64}$/); expect(lines[17]).toBe(sha(raw.subarray(0, raw.length - 65)));
  const ownerRaw = await readFile(join(data, "backend-state/control/owner.marker"));
  expect(ownerRaw.length).toBeLessThanOrEqual(1024);
  expect([...ownerRaw].every(byte => byte === 10 || byte >= 32 && byte <= 126)).toBe(true);
  expect(ownerRaw.at(-1)).toBe(10);
  const owner = ownerRaw.toString("ascii").slice(0, -1).split("\n"); expect(owner).toHaveLength(4);
  expect(owner[0]).toBe("TAHTIAPURI_BACKEND_STATE_V1"); expect(owner[1]).toMatch(/^S-\d+(?:-\d+)+$/);
  expect(owner[2]).toMatch(/^[a-f0-9]{24}$/); expect(owner[3]).toMatch(/^[a-f0-9]{24}$/);
  expect(lines.slice(2, 5)).toEqual(owner.slice(1));
  expect(lines[5]).toBe("OWNER_SYSTEM_PROTECTED_MEDIUM_V1"); expect(lines[6]).toBe("CREATION_JOB_LIST_GLOBAL_V1");
  expect(lines[7]).toBe("CLEAN"); expect(lines[12]).toBe("NONE"); expect(lines[14]).toBe("NONE");
  for (const index of [8, 9, 10, 11, 13, 15, 16]) expect(lines[index]).toBe("-");
  return { sha256: sha(raw), packageDigest: digest, ownerContext: owner.slice(1), phase: lines[7] };
}

function observeElectron(application: ElectronApplication, started: number) {
  const child = application.process(), limit = 65536, events: Record<string, unknown>[] = [];
  let sequence = 0, droppedEvents = 0, stopped = false;
  const elapsed = () => Math.round(performance.now() - started);
  const message = (error: unknown) => { try { return error instanceof Error ? error.message.slice(0, 512) : "non-Error observer failure"; } catch { return "unreadable observer failure"; } };
  const record = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      if (stopped) return;
      const index = ++sequence;
      if (events.length < 32) events.push({ sequence: index, elapsedMs: elapsed(), event, ...fields }); else droppedEvents++;
    } catch { droppedEvents++; } // Event callbacks must never throw into Electron/Playwright.
  };
  const stream = (name: string, input: Readable | null) => {
    const bytes = Buffer.alloc(limit);
    const stats = { available: input !== null, receivedBytes: 0, storedBytes: 0, truncated: false,
      counterSaturated: false, captureErrors: 0, endObserved: input?.readableEnded ?? false, closeObserved: false };
    let first = true;
    const onData = (chunk: Buffer | string) => {
      try {
        const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        const total = stats.receivedBytes + length;
        stats.counterSaturated ||= total > Number.MAX_SAFE_INTEGER;
        stats.receivedBytes = Math.min(total, Number.MAX_SAFE_INTEGER);
        const count = Math.min(length, limit - stats.storedBytes);
        if (count > 0) stats.storedBytes += typeof chunk === "string"
          ? bytes.write(chunk, stats.storedBytes, count, "utf8") : chunk.copy(bytes, stats.storedBytes, 0, count);
        stats.truncated = stats.receivedBytes > stats.storedBytes;
        if (first) { first = false; record(name + "-first-data", { receivedBytes: length }); }
      } catch (error) { stats.captureErrors++; record(name + "-capture-error", { message: message(error) }); }
    };
    const onEnd = () => { try { stats.endObserved = true; record(name + "-end"); } catch { stats.captureErrors++; } };
    const onClose = () => { try { stats.closeObserved = true; record(name + "-close"); } catch { stats.captureErrors++; } };
    const onError = (error: unknown) => { try { stats.captureErrors++; record(name + "-error", { message: message(error) }); } catch { /* Diagnostic only. */ } };
    input?.on("data", onData); input?.on("end", onEnd); input?.on("close", onClose); input?.on("error", onError);
    return {
      snapshot: () => ({ ...stats, droppedBytes: stats.receivedBytes - stats.storedBytes }),
      body: () => Buffer.from(bytes.subarray(0, stats.storedBytes)),
      stop: () => { input?.off("data", onData); input?.off("end", onEnd); input?.off("close", onClose); },
      // Keep the nonthrowing error listener after stopping data capture.
    };
  };
  const stdout = stream("stdout", child.stdout), stderr = stream("stderr", child.stderr);
  type Exit = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "process-error"; message: string };
  let resolveExit!: (value: Exit) => void;
  const exit = new Promise<Exit>(resolve => { resolveExit = resolve; }); // Always resolves, including when it loses the race.
  let exitObservation: Record<string, unknown> | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    try { exitObservation = { source: "exit-event", elapsedMs: elapsed(), code, signal }; record("process-exit", { code, signal }); }
    catch { /* Resolving the exit outcome must not depend on diagnostic bookkeeping. */ }
    resolveExit({ kind: "exit", code, signal });
  };
  child.once("exit", onExit);
  child.once("close", (code, signal) => { record("process-close", { code, signal }); });
  child.on("error", error => { const text = message(error); record("process-error", { message: text }); resolveExit({ kind: "process-error", message: text }); });
  record("observer-attached", { pid: child.pid });
  if (child.exitCode !== null || child.signalCode !== null) {
    exitObservation = { source: "already-exited-at-attachment", observedElapsedMs: elapsed(), code: child.exitCode, signal: child.signalCode };
    record("process-already-exited", { code: child.exitCode, signal: child.signalCode });
    resolveExit({ kind: "exit", code: child.exitCode, signal: child.signalCode });
  }
  return {
    firstWindow: async () => {
      // Handle both window outcomes immediately: an exit winner must not leave
      // a later timeout rejection unhandled. Product startup limits are unchanged.
      const window = application.firstWindow({ timeout: 45_000 }).then(page => ({ kind: "window" as const, page }),
        error => ({ kind: "window-error" as const, error }));
      const outcome = await Promise.race([window, exit]);
      if (outcome.kind === "window") { record("first-window"); return outcome.page; }
      if (outcome.kind === "window-error") { record("first-window-error", { message: message(outcome.error) }); throw outcome.error; }
      if (outcome.kind === "process-error") throw new Error("Electron process error before first window: " + outcome.message);
      throw new Error("Electron exited before first window: code=" + outcome.code + ", signal=" + outcome.signal);
    },
    stop: () => { record("observer-stopped"); stopped = true; stdout.stop(); stderr.stop(); },
    snapshot: () => ({ captureStartsAfterLaunchReturns: true, earlierOutputMayBeMissing: true, streamLimitBytes: limit, eventLimit: 32,
      eventTimes: "Monotonic milliseconds from this test start only", events: [...events], droppedEvents,
      exit: exitObservation ? { ...exitObservation } : null, stdout: stdout.snapshot(), stderr: stderr.snapshot() }),
    stdout: stdout.body, stderr: stderr.body,
  };
}

test("real native CPU answer crosses the native backend and preserves its owned observing data", async ({}, info) => {
  test.setTimeout(300_000);
  const started = performance.now();
  const data = await freshCase();
  const report: Record<string, unknown> = { scope: "native-backend-model-cpu", data, syntheticCaseRetained: true,
    evidenceScope: "UI/native CPU composition, owned storage and normal shutdown; no independent OS inventory or network validation" };
  let application: ElectronApplication | undefined;
  let observation: ReturnType<typeof observeElectron> | undefined;
  let failed = false;
  const source = join(data, "observing/places.json"), destination = join(data, "backend-state/data/observing/places.json");
  const marker = join(data, "backend-state/control/observing-migration.marker");
  const modelWork = join(data, "native-model"), backendSessions = join(data, "native-backend/sessions");
  try {
    await info.attach("retained-synthetic-case", { body: JSON.stringify({ data }), contentType: "application/json" });
    const metadata = JSON.parse(await readFile(join(runtimeRoot!, "runtime-descriptor.json"), "utf8")) as { package: { digest: string } };
    expect(metadata.package.digest).toMatch(/^[a-f0-9]{64}$/);
    application = await launch(data, "native-backend-model");
    observation = observeElectron(application, started);
    const page = await observation.firstWindow();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    await expect(page.getByLabel("Salli Codex/MCP-kehitysyhteys")).not.toBeChecked();
    const legacy = await readFile(source), initial = storage(legacy), originalMarker = await readFile(marker);
    expect(initial).toEqual({ revision: 0, places: [], activePlaceId: null });
    expect(await readFile(destination)).toEqual(legacy);
    report.legacySourceSha256 = sha(legacy); report.initialMarkerSha256 = sha(originalMarker);

    await addPlace(page, "Synthetic native CPU place", "0", "0", "UTC");
    const saved = await readFile(destination), savedState = storage(saved);
    expect(savedState.places).toHaveLength(1); expect(savedState.activePlaceId).toBe(savedState.places[0]!.id);
    expect(savedState.revision).toBeGreaterThan(initial.revision);
    expect(savedState.places[0]).toMatchObject({ name: "Synthetic native CPU place", timeZone: "UTC",
      observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } });
    await expect(page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true })).toHaveValue(savedState.activePlaceId!);
    expect(await readFile(source)).toEqual(legacy); expect(await readFile(marker)).toEqual(originalMarker);
    report.nativeSavedSha256 = sha(saved); report.savedState = savedState;

    await page.getByLabel("Laskentatapa", { exact: true }).selectOption("cpu");
    await page.getByLabel("Kysymys paikalliselle mallille").fill(prompt);
    await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
    const job = page.locator("[data-job-id]");
    await expect(job).toHaveAttribute("data-job-id", /^[a-f0-9-]{36}$/);
    const id = await job.getAttribute("data-job-id"); if (!id) throw new Error("Native CPU job identity missing.");
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), id);
      return result.ok ? result.job.state : "unavailable";
    }, { timeout: 190_000, intervals: [300, 500, 1000] }).toMatch(/^(completed|error|cancelled)$/);
    const answer = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), id);
    await info.attach("native-backend-model-answer", { body: JSON.stringify(answer, null, 2), contentType: "application/json" });
    expect(answer).toMatchObject({ ok: true, job: { state: "completed", error: null,
      info: { engineVersion: "llama.cpp-v0.9.0-cpu", backend: "cpu", gpuLayers: 0, contextSize: 4096 } } });
    if (!answer.ok) throw new Error("Native CPU result unavailable.");
    expect(answer.job.text).toMatch(/^Jupiter\.?$/);
    await expect(page.getByTestId("model-answer")).toHaveText(/^Jupiter\.?$/);
    await expect(page.getByRole("status", { name: "Mallin tila", exact: true })).toHaveText("Vastaus valmis");
    await emptyDirectory(modelWork); report.modelStageEmptyAfterCompleted = true;
    expect(await readFile(destination)).toEqual(saved); expect(await readFile(source)).toEqual(legacy);
    expect(await readFile(marker)).toEqual(originalMarker);
    report.modelResultCompleted = true;

    const process = application.process(); await application.close();
    report.applicationExitCode = process.exitCode; report.applicationSignalCode = process.signalCode;
    expect(process.exitCode).toBe(0); expect(process.signalCode).toBeNull(); application = undefined;
    report.journal = await cleanJournal(data, metadata.package.digest);
    await emptyDirectory(backendSessions); await emptyDirectory(modelWork);
    expect(await readFile(destination)).toEqual(saved); expect(await readFile(source)).toEqual(legacy);
    expect(await readFile(marker)).toEqual(originalMarker);
    report.backendSessionsEmptyAfterClose = true; report.modelStageEmptyAfterClose = true;
    report.nativeDataAndLegacySourceBytesPreserved = true; report.markerBytesPreserved = true;
  } catch (error) {
    failed = true; report.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    let cleanupFailed = false, cleanupError: unknown;
    if (application) {
      try {
        const process = application.process(); await application.close();
        report.failureCleanupAppExitCode = process.exitCode; report.failureCleanupAppSignalCode = process.signalCode;
      } catch (error) {
        cleanupFailed = true; cleanupError = error;
        report.failureCleanup = "unverified"; report.failureCleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    let diagnosticFailed = false, diagnosticError: unknown;
    if (observation) {
      try {
        observation.stop(); report.electronProcess = observation.snapshot();
        for (const [name, body] of [["electron-process-stdout", observation.stdout], ["electron-process-stderr", observation.stderr]] as const) {
          try { await info.attach(name, { body: body(), contentType: "application/octet-stream" }); }
          catch (error) { diagnosticFailed = true; diagnosticError = error; }
        }
      } catch (error) { diagnosticFailed = true; diagnosticError = error; }
      if (diagnosticFailed) report.electronDiagnosticFailure = diagnosticError instanceof Error ? diagnosticError.message : "Diagnostic retention failed.";
    }
    try { await info.attach("native-backend-model-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" }); }
    catch (error) { if (!failed) throw error; }
    if (cleanupFailed && !failed) throw cleanupError;
    if (diagnosticFailed && !failed) throw diagnosticError;
  }
});
