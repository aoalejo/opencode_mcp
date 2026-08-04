import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Machine-local usage history, outside the repo (same convention as
// opencode's own ~/.local/share/opencode) since it's not code, it grows
// forever, and it shouldn't be committed.
const USAGE_DIR = path.join(homedir(), ".local", "share", "opencode-mcp");
const USAGE_LOG_PATH = path.join(USAGE_DIR, "usage-log.jsonl");

/**
 * Append one line per finished job (called from jobs.js on completion,
 * success or failure — a failed job still spent tokens/time and is worth
 * counting). `responseChars` is passed in rather than recomputed here to
 * avoid a circular import with jobs.js's assembledText().
 */
export function recordUsage(job, responseChars) {
  try {
    mkdirSync(USAGE_DIR, { recursive: true });
    const record = {
      jobId: job.id,
      finishedAt: job.finishedAt,
      durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      status: job.status,
      model: job.model,
      variant: job.variant ?? null,
      tier: job.tier ?? null,
      tokens: job.tokens,
      cost: job.cost,
      promptChars: job.prompt?.length ?? 0,
      responseChars,
    };
    appendFileSync(USAGE_LOG_PATH, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error("[opencode-mcp] failed to record usage:", e.message ?? e);
  }
}

export function readUsageLog() {
  if (!existsSync(USAGE_LOG_PATH)) return [];
  return readFileSync(USAGE_LOG_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Aggregate the log into totals and a per-model breakdown. `cost` is
 * OpenCode's own list-price cost for the tokens used — under the Go
 * subscription (flat-rate) or Zen (free tier) the actual dollars charged is
 * $0 regardless, so `totals.cost` IS the savings vs. paying per-token for
 * the same work. It is NOT a comparison against Anthropic/Claude API
 * pricing — this MCP has no way to know what the equivalent work would have
 * cost in a different tokenizer/model, so it doesn't claim to.
 */
export function summarizeUsage(records) {
  const totals = {
    jobs: records.length,
    completed: 0,
    failed: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    promptChars: 0,
    responseChars: 0,
    durationMs: 0,
  };
  const byModel = {};

  for (const r of records) {
    if (r.status === "completed") totals.completed++;
    if (r.status === "failed") totals.failed++;
    totals.tokens.input += r.tokens?.input ?? 0;
    totals.tokens.output += r.tokens?.output ?? 0;
    totals.tokens.reasoning += r.tokens?.reasoning ?? 0;
    totals.tokens.cacheRead += r.tokens?.cache?.read ?? 0;
    totals.tokens.cacheWrite += r.tokens?.cache?.write ?? 0;
    totals.cost += r.cost ?? 0;
    totals.promptChars += r.promptChars ?? 0;
    totals.responseChars += r.responseChars ?? 0;
    totals.durationMs += r.durationMs ?? 0;

    const key = r.model ?? "unknown";
    byModel[key] ??= { jobs: 0, tier: r.tier ?? null, cost: 0, tokens: { input: 0, output: 0 }, responseChars: 0 };
    byModel[key].jobs++;
    byModel[key].cost += r.cost ?? 0;
    byModel[key].tokens.input += r.tokens?.input ?? 0;
    byModel[key].tokens.output += r.tokens?.output ?? 0;
    byModel[key].responseChars += r.responseChars ?? 0;
  }

  return { totals, byModel };
}
