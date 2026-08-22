import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { recordUsage } from "./usage.js";
import { persistJob, loadPersistedJob } from "./job-store.js";

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
      // Checkpoint to disk here (not on every raw chunk) — frequent enough
      // that a killed/restarted server process still leaves recent progress
      // recoverable, not so frequent it's meaningful disk I/O overhead.
      persistJob(job, assembledText(job));
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
    tier: opts.tier,
    onDone: opts.onDone,
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
  persistJob(job, ""); // initial record — even a job that dies before any output is at least known to have started

  child.stdout.on("data", (chunk) => processChunk(job, chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => {
    job.stderr += chunk.toString("utf8");
    if (job.stderr.length > 8000) job.stderr = job.stderr.slice(-8000);
  });

  // Node's 'close' only fires once ALL stdio file descriptors are closed —
  // if `opencode run` left a descendant process running (a background bash
  // command, another MCP server it connected to, an orphaned watcher) that
  // inherited those pipes, 'close' can be delayed indefinitely even though
  // opencode's own process — and the real work it did — is long finished.
  // 'exit' fires the instant the process itself terminates, independent of
  // its pipes, so it's the reliable signal; 'close' is kept as a backstop
  // for whichever case fires first. `settled` prevents double-finalizing if
  // both arrive (the normal case — usually milliseconds apart).
  let settled = false;
  let settledAt = null;
  function finalize(code, via, signal) {
    if (settled) {
      // The other event still arrived eventually — log the gap so we have
      // real production evidence of how often/how badly this actually
      // happens, rather than just trusting the fix worked from synthetic
      // tests.
      const gapMs = Date.now() - settledAt;
      if (gapMs > 2000) {
        console.error(`[opencode-mcp] job ${id}: '${via}' arrived ${gapMs}ms after the event that already settled it — a descendant process likely held the pipe open.`);
      }
      return;
    }
    settled = true;
    settledAt = Date.now();
    job.exitCode = code;
    job.finishedAt = Date.now();
    // `code` is null (not 0) when the process was killed by a signal rather
    // than exiting on its own (Node's exit event is (code, signal), and this
    // used to silently discard signal) — that produced a "failed" job with
    // exitCode:null, errorMessage:null, zero tokens, and NO indication of
    // why. Observed 2026-08-22: a whole opencode_investigate swarm's 3
    // participants all died this way (likely a saturated/restarting local
    // model dropping their connections) with zero diagnostic trail, and the
    // aggregator — itself a real agent with read access — quietly redid the
    // investigation from scratch instead of surfacing the total failure, so
    // the swarm's redundancy/corroboration guarantee silently evaporated
    // behind an apparently-successful report. Recording the signal here is
    // what lets a caller actually notice and explain this instead of
    // guessing "failed, no reason given."
    if (signal && !job.errorMessage) {
      job.errorMessage = `Process was killed by signal ${signal} before finishing (not a normal exit) — often caused by the model backend dropping the connection, an OOM kill, or something external terminating the process.`;
    }
    if (job.status === "running") {
      job.status = code === 0 && !job.errorMessage ? "completed" : "failed";
    }
    const finalText = assembledText(job);
    recordUsage(job, finalText.length);
    persistJob(job, finalText);
    try {
      job.onDone?.(job);
    } catch (e) {
      console.error("[opencode-mcp] onDone callback threw:", e.message ?? e);
    }
    job.events.emit("done");
  }
  child.on("exit", (code, signal) => finalize(code, "exit", signal));
  child.on("close", (code, signal) => finalize(code, "close", signal));
  child.on("error", (err) => {
    job.errorMessage = err.message;
    finalize(job.exitCode ?? 1, "error");
  });

  return id;
}

/**
 * Falls back to the on-disk snapshot (see job-store.js) when this process
 * has no live record — either it restarted since the job ran, or a
 * DIFFERENT process (another Claude Code session) started it. The returned
 * object has no `child`/`events` (the real process is gone or elsewhere) but
 * carries everything jobSummary/opencode_resume_job need: model, variant,
 * dir, sessionId, the assembled text as of its last checkpoint, and status.
 */
export function getJob(id) {
  return jobs.get(id) ?? loadPersistedJob(id);
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
  // A live job has `textParts` (Map, assembled on demand); a job reloaded
  // from disk via loadPersistedJob already has a plain `text` string (and no
  // child process, so nothing left to assemble from).
  const text = job.textParts ? assembledText(job) : (job.text ?? "");
  return {
    jobId: job.id,
    status: job.status,
    model: job.model,
    variant: job.variant,
    tier: job.tier,
    agent: job.agent,
    dir: job.dir,
    sessionId: job.sessionId,
    prompt: job.prompt,
    exitCode: job.exitCode,
    tokens: job.tokens,
    cost: job.cost,
    errorMessage: job.errorMessage,
    stderrTail: job.stderrTail ?? (job.stderr ? job.stderr.slice(-2000) : undefined),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    text,
  };
}
