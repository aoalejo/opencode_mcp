import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Machine-local, outside the repo — same convention as usage.js's log.
const JOBS_DIR = path.join(homedir(), ".local", "share", "opencode-mcp", "jobs");

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

/**
 * Snapshot a job's current state to disk so it survives this MCP server
 * process restarting or crashing, and so a DIFFERENT process (another
 * Claude Code session) can look it up — in-memory-only tracking means "No
 * job with id ..." the instant the process that started it goes away, even
 * though the real opencode session and its output are still completely
 * intact. Called on every meaningful checkpoint (each step_finish, and on
 * final completion/failure), not just at the end, so a killed process still
 * leaves the latest known state recoverable rather than nothing at all.
 */
export function persistJob(job, text) {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
    const snapshot = {
      id: job.id,
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
      stderrTail: job.stderr ? job.stderr.slice(-2000) : undefined,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      text,
    };
    writeFileSync(jobPath(job.id), JSON.stringify(snapshot));
  } catch (e) {
    console.error("[opencode-mcp] failed to persist job snapshot:", e.message ?? e);
  }
}

/** Plain snapshot object (no live child process/EventEmitter) or null if never persisted. */
export function loadPersistedJob(id) {
  const p = jobPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
