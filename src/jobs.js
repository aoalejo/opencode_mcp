import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/** @type {Map<string, Job>} */
const jobs = new Map();

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {"running"|"completed"|"failed"|"cancelled"} status
 * @property {string} prompt
 * @property {string|undefined} model
 * @property {string|undefined} agent
 * @property {string|undefined} dir
 * @property {string|null} sessionId
 * @property {import("node:child_process").ChildProcess} child
 * @property {Map<string, {text: string, seq: number}>} textParts
 * @property {number} nextSeq
 * @property {{input:number,output:number,reasoning:number}} tokens
 * @property {number} cost
 * @property {string} stderr
 * @property {string} stdoutBuffer
 * @property {number|null} exitCode
 * @property {string|null} errorMessage
 * @property {number} startedAt
 * @property {number|null} finishedAt
 */

function upsertTextPart(job, part) {
  const existing = job.textParts.get(part.id);
  job.textParts.set(part.id, {
    text: part.text ?? "",
    seq: existing ? existing.seq : job.nextSeq++,
  });
}

function handleEvent(job, event) {
  if (event.sessionID && !job.sessionId) job.sessionId = event.sessionID;

  switch (event.type) {
    case "text":
      if (event.part?.id) upsertTextPart(job, event.part);
      break;
    case "step_finish": {
      const t = event.part?.tokens;
      if (t) {
        job.tokens.input += t.input ?? 0;
        job.tokens.output += t.output ?? 0;
        job.tokens.reasoning += t.reasoning ?? 0;
      }
      if (typeof event.part?.cost === "number") job.cost += event.part.cost;
      break;
    }
    case "error":
      job.errorMessage =
        event.error?.data?.message ??
        event.error?.message ??
        event.part?.message ??
        event.message ??
        JSON.stringify(event.error ?? event);
      break;
    default:
      break;
  }
}

function processChunk(job, chunk) {
  job.stdoutBuffer += chunk;
  const lines = job.stdoutBuffer.split("\n");
  job.stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      handleEvent(job, JSON.parse(trimmed));
    } catch {
      // non-JSON line (shouldn't happen with --format json); ignore
    }
  }
}

/**
 * Start an `opencode run` job in the background and return its id immediately.
 * @param {{prompt: string, model?: string, agent?: string, dir?: string, files?: string[], title?: string, sessionId?: string, continueSession?: boolean, auto?: boolean}} opts
 */
export function startJob(opts) {
  const args = ["run", opts.prompt, "--format", "json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.variant) args.push("--variant", opts.variant);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.title) args.push("--title", opts.title);
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.continueSession) args.push("--continue");
  if (opts.dir) args.push("--dir", opts.dir);
  if (opts.auto) args.push("--auto");
  for (const f of opts.files ?? []) args.push("-f", f);

  const child = spawn("opencode", args, {
    cwd: opts.dir || undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const id = randomUUID();
  /** @type {Job} */
  const job = {
    id,
    status: "running",
    prompt: opts.prompt,
    model: opts.model,
    variant: opts.variant,
    agent: opts.agent,
    dir: opts.dir,
    sessionId: null,
    child,
    textParts: new Map(),
    nextSeq: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    stderr: "",
    stdoutBuffer: "",
    exitCode: null,
    errorMessage: null,
    startedAt: Date.now(),
    finishedAt: null,
    events: new EventEmitter(),
  };
  jobs.set(id, job);

  child.stdout.on("data", (chunk) => processChunk(job, chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => {
    job.stderr += chunk.toString("utf8");
    if (job.stderr.length > 8000) job.stderr = job.stderr.slice(-8000);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = Date.now();
    if (job.status === "running") {
      job.status = code === 0 && !job.errorMessage ? "completed" : "failed";
    }
    job.events.emit("done");
  });
  child.on("error", (err) => {
    job.errorMessage = err.message;
    job.status = "failed";
    job.finishedAt = Date.now();
    job.events.emit("done");
  });

  return id;
}

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()];
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "running") {
    job.child.kill("SIGTERM");
    job.status = "cancelled";
    job.finishedAt = Date.now();
  }
  return true;
}

export function assembledText(job) {
  return [...job.textParts.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((p) => p.text)
    .join("");
}

/**
 * Wait up to timeoutMs for a job to leave "running" status. Resolves the
 * instant the underlying process actually exits (event-driven via the job's
 * "done" emitter) rather than polling on an interval — timeoutMs is only an
 * upper bound for jobs that are still running when it elapses.
 */
export function waitForJob(id, timeoutMs) {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer;
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    job.events.once("done", onDone);
    timer = setTimeout(() => {
      job.events.off("done", onDone);
      resolve();
    }, timeoutMs);
  });
}

export function jobSummary(job) {
  return {
    jobId: job.id,
    status: job.status,
    model: job.model,
    variant: job.variant,
    agent: job.agent,
    dir: job.dir,
    sessionId: job.sessionId,
    prompt: job.prompt,
    exitCode: job.exitCode,
    tokens: job.tokens,
    cost: job.cost,
    errorMessage: job.errorMessage,
    stderrTail: job.stderr ? job.stderr.slice(-2000) : undefined,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    text: assembledText(job),
  };
}
