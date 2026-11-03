import { randomUUID } from "node:crypto";
import type { ModelEngine } from "../ports/model-engine.js";
import type { AssistantResult, JobView, ModelInput } from "@tahtiapuri/validation/assistant";
type Job = { view: JobView; input: ModelInput };
const terminal = (view: JobView) => ["completed", "cancelled", "error"].includes(view.state);
export class AssistantService {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active: Job | undefined;
  private closed = false;
  constructor(private readonly engine: ModelEngine) {}
  submit(input: ModelInput): AssistantResult {
    if (this.closed) return { ok: false, code: "ENGINE_UNAVAILABLE" };
    if (this.queue.length + (this.active ? 1 : 0) >= 2) return { ok: false, code: "BUSY" };
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 6) break;
      if (terminal(job.view)) this.jobs.delete(id);
    }
    const view: JobView = { id: randomUUID(), state: "queued", text: "", error: null, info: null };
    const job = { view, input };
    this.jobs.set(view.id, job); this.queue.push(job); this.pump();
    return { ok: true, job: { ...view } };
  }
  get(id: string): AssistantResult {
    const job = this.jobs.get(id);
    return job ? { ok: true, job: { ...job.view } } : { ok: false, code: "INVALID_INPUT" };
  }
  cancel(id: string): AssistantResult {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, code: "INVALID_INPUT" };
    if (!terminal(job.view)) {
      job.view = { ...job.view, state: "cancelled", text: "", error: "CANCELLED" };
      if (this.active === job) this.engine.cancel(id);
      else this.queue = this.queue.filter(item => item !== job);
    }
    return this.get(id);
  }
  dispose() {
    this.closed = true;
    for (const id of this.jobs.keys()) this.cancel(id);
  }
  private pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job; job.view.state = "loading";
    void this.engine.run(job.view.id, job.input, () => {
      if (!terminal(job.view)) job.view.state = "running";
    }).then(reply => {
      if (terminal(job.view)) return;
      job.view = { ...job.view, ...reply, state: reply.error ? "error" : "completed" };
    }).catch(() => {
      if (!terminal(job.view)) job.view = { ...job.view, state: "error", error: "ENGINE_CRASHED" };
    }).finally(() => { this.active = undefined; this.pump(); });
  }
}
