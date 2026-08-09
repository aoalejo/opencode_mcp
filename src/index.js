#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listProviders, listModels, modelInfo } from "./catalog.js";
import { startJob, getJob, listJobs, cancelJob, waitForJob, jobSummary } from "./jobs.js";
import {
  TIER_NAMES,
  DEFAULT_TIER,
  getTierMap,
  getTierMapMeta,
  saveTierMap,
  resolveModel,
  isStale,
  getBlocklist,
  blockModel,
  recordSuccess,
  unblockModel,
  listBlocked,
  pinnedModel,
} from "./tiers.js";
import { computeTierMap } from "./rank.js";
import { readUsageLog, summarizeUsage } from "./usage.js";

/**
 * Mark a tier's final winner as `inherited` when a strictly cheaper tier's
 * final winner is the same model+variant — i.e. the cumulative cost pools in
 * computeTierMap actually collapsed two tiers together. Purely informational.
 */
function flagInheritedTiers(tiers) {
  TIER_NAMES.forEach((name, i) => {
    const cheaperMatch = TIER_NAMES.slice(0, i).find(
      (cheaperName) => tiers[cheaperName].model === tiers[name].model && tiers[cheaperName].variant === tiers[name].variant
    );
    tiers[name].inherited = Boolean(cheaperMatch);
    tiers[name].inheritedFrom = cheaperMatch ?? null;
  });
}

/**
 * Recompute the tier map from cost + arena score. No probing, no opencode run
 * calls at all — purely a local CLI call (`opencode models --verbose`) plus
 * one HTTP fetch of the arena leaderboard, so it's effectively free and can
 * run on every stale check without a second thought. Models confirmed broken
 * by actual job failures (see recordJobOutcome) are excluded via the live
 * blocklist rather than re-probed.
 */
async function refreshTierMap() {
  const result = await computeTierMap({ blocklist: getBlocklist() });
  const tiers = result.tiers;
  flagInheritedTiers(tiers);
  saveTierMap({ ...result, tiers });
  return { tiers, unmatched: result.unmatched, blocked: result.blocked, matchedCount: result.candidates.length, computedAt: result.computedAt };
}

/**
 * Called from jobs.js when ANY job finishes, whether or not anyone is
 * waiting on it (fire-and-forget jobs self-heal this way too — see
 * opencode_start_job). A confirmed failure (real error/non-zero exit, not
 * just "still running" — see jobs.js, waitForJob's timeout never sets
 * status to "failed") on a job that used a `tier` blocks that model+variant
 * with exponential backoff (see tiers.js's BACKOFF_SCHEDULE_MS) so a single
 * transient blip only costs a few minutes of routing around it, not a full
 * day — observed 2026-08-08, a brief real outage kept low/mid/high on a
 * pricier fallback for hours because the old design used a flat 24h block.
 * A subsequent SUCCESS on that same model+variant clears its failure history
 * entirely, so backoff always starts fresh rather than compounding forever.
 */
function recordJobOutcome(job) {
  if (!job.tier) return;
  if (job.status === "failed") {
    blockModel(job.model, job.variant, job.errorMessage || "job failed");
    console.error(`[opencode-mcp] ${job.model}${job.variant ? "/" + job.variant : ""} failed (tier ${job.tier}) — backed off.`);
    refreshTierMap().catch((e) => console.error("[opencode-mcp] post-failure tier refresh failed:", e.message ?? e));
  } else if (job.status === "completed") {
    if (recordSuccess(job.model, job.variant)) {
      refreshTierMap().catch((e) => console.error("[opencode-mcp] post-recovery tier refresh failed:", e.message ?? e));
    }
  }
}

/**
 * Auto-refresh the tier map once it's more than a day old — no tool call,
 * no tokens spent describing it to the caller. Fire-and-forget: the job
 * that triggered the check still resolves against whatever map is on disk
 * right now; the refreshed map (if the day-old check fires) is only ready
 * for the *next* call. Errors are logged to stderr, never surfaced to a
 * caller who didn't ask for this.
 */
let autoRefreshInFlight = null;
function maybeAutoRefreshTiers() {
  if (autoRefreshInFlight || !isStale()) return;
  autoRefreshInFlight = refreshTierMap()
    .then(() => {
      console.error("[opencode-mcp] tier map was stale (>1 day) — auto-refreshed.");
    })
    .catch((e) => {
      console.error("[opencode-mcp] automatic tier refresh failed:", e.message ?? e);
    })
    .finally(() => {
      autoRefreshInFlight = null;
    });
}

const server = new McpServer({ name: "opencode-mcp", version: "0.1.0" });

const HANDOFF_SUFFIX =
  "\n\n---\nRespond with only the final result — no preamble, no restating " +
  "the task, no narrating your process or tool use. Use tools/read files as " +
  "needed to do the work, but the text you return should be just the " +
  "answer/deliverable itself, ready to hand off as-is.";

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

server.tool(
  "opencode_list_providers",
  "List the OpenCode providers/credentials configured on this machine (e.g. OpenCode Zen, OpenCode Go, OpenRouter). Names only, no secrets.",
  {},
  async () => {
    try {
      return ok({ providers: await listProviders() });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_list_models",
  'List available "provider/model" ids from opencode. For everyday jobs, prefer the `tier` param on opencode_start_job (low/mid/high/max) instead of picking a model here — use this tool only when you need something outside the tier map. Optionally filter by provider (e.g. "opencode", "opencode-go", "openrouter").',
  { provider: z.string().optional().describe('Provider id to filter by, e.g. "opencode-go"') },
  async ({ provider }) => {
    try {
      return ok({ provider: provider ?? null, models: await listModels(provider) });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_model_info",
  'Get verbose metadata (cost per token, context window, capabilities) for one model. `model` must be "provider/model", e.g. "opencode/big-pickle".',
  { model: z.string().describe('e.g. "opencode/big-pickle" or "opencode-go/kimi-k3"') },
  async ({ model }) => {
    try {
      const info = await modelInfo(model);
      if (!info) return err(`Model "${model}" not found.`);
      return ok(info);
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_check_go_status",
  "Check the OpenCode Go subscription: confirms the credential is configured and lists the opencode-go models currently on offer (availability/lineup can change). Pass probe:true to also send a trivial ping to the mid/high/max tier models and confirm they're actually responding right now — that costs a small amount of tokens/time, so only do it when you're about to rely on the result (e.g. before delegating a big job), not as a routine check.",
  {
    probe: z
      .boolean()
      .optional()
      .describe("If true, ping the mid/high/max tier models with a 1-word prompt. Default false."),
  },
  async ({ probe }) => {
    maybeAutoRefreshTiers();
    try {
      const providers = await listProviders();
      const subscriptionConfigured = providers.includes("OpenCode Go");
      const availableModels = subscriptionConfigured ? await listModels("opencode-go") : [];
      const tierMap = getTierMap();
      const result = {
        subscriptionConfigured,
        availableModels,
        tiers: tierMap,
        tierMapMeta: getTierMapMeta(),
        blocked: listBlocked(),
        pinnedModel: pinnedModel(),
      };

      if (probe && subscriptionConfigured) {
        const probes = {};
        for (const [tierName, cfg] of Object.entries(tierMap)) {
          if (!cfg.model.startsWith("opencode-go/")) continue;
          const jobId = startJob({ prompt: "Reply with exactly: OK", model: cfg.model, variant: cfg.variant });
          await waitForJob(jobId, 20000);
          const s = jobSummary(getJob(jobId));
          probes[tierName] = { model: cfg.model, variant: cfg.variant, status: s.status, errorMessage: s.errorMessage };
        }
        result.probes = probes;
      }
      return ok(result);
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_refresh_tiers",
  "Force an immediate recompute of the low/mid/high/max tier map (cross-referencing opencode-go cost data against the WebDev/code arena leaderboard; each tier's pool is cumulative — everything at or under its cost ceiling — and its winner is the CHEAPEST model within 1% of the pool's best arena score, not just the outright top scorer, so a near-tie doesn't cost 10x more for nothing). This is a pure local computation (one CLI call, one HTTP fetch) — no probing, no opencode run calls, effectively free. This normally happens automatically once a day the first time a job is delegated — use this tool only when you need it to happen RIGHT NOW (e.g. right after a model lineup change), not as a routine step. Use opencode_unblock_model instead if you specifically want to give a recently-failed model another chance.",
  {},
  async () => {
    try {
      return ok(await refreshTierMap());
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_unblock_model",
  "Manually clear a model+variant from the failure blocklist (see opencode_check_go_status's `blocked` field for what's currently excluded, including remaining backoff time) and immediately recompute tiers so it's back in rotation. Blocks use exponential backoff (5min/30min/2h/8h/24h by consecutive failure count, reset on the next success) so this is mostly useful to skip a wait early — e.g. right after re-enabling a model in the OpenCode dashboard — not routinely needed otherwise.",
  {
    model: z.string().describe('e.g. "opencode-go/deepseek-v4-flash"'),
    variant: z.string().optional().describe('e.g. "high" — omit if the blocked entry has no variant'),
  },
  async ({ model, variant }) => {
    try {
      const existed = unblockModel(model, variant ?? null);
      const refreshed = await refreshTierMap();
      return ok({ existed, ...refreshed });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_start_job",
  "Send a job (a prompt/task) to OpenCode to work on. Pick a `tier` (low/mid/high/max) instead of a specific model name — tiers are data-driven (see opencode_refresh_tiers): each is the cheapest model within 1% of the best arena score in its cost band on the OpenCode Go subscription (flat-rate, no marginal cost). Default to the lowest tier that can plausibly do the job; only reach for `max` when the task clearly needs the deepest reasoning available. Pass an explicit `model` instead of `tier` only when you specifically need something outside the tier map (see opencode_list_models). Output defaults to a clean hand-off (final result only, no narrated process) — set style:\"verbose\" only if you actually want to see the model's exploration/reasoning (e.g. debugging why a job did something unexpected).\n\nA `tier` pick that fails outright (real error, e.g. region-locked/disabled — not just slow) is automatically retried with the next-best candidate in the same cost pool, and gets excluded from future resolutions with exponential backoff (5min for a first failure, escalating toward 24h only if it keeps failing on repeated real attempts — see opencode_unblock_model to clear that early). This happens on real usage only — there is no separate probing step burning tokens just to check.\n\nIf the OPENCODE_MCP_PIN_MODEL env var is set on this server process, EVERY `tier` resolution uses that fixed model instead (ranking/blocklist bypassed entirely) — set at registration time to force one model for a whole session; check opencode_check_go_status's `pinnedModel` field to see if that's active right now.\n\nIMPORTANT — there is no push notification when a job finishes: MCP tool calls are strictly request/response, this server cannot interrupt the conversation on its own, and nothing resembling the native run_in_background task-notification exists here. Pass `waitMs` (recommended for most jobs — up to 540000ms/9min) to block this single call until the job actually finishes and get the full result back directly (also required for the automatic fallback above to retry within this same call). Omit `waitMs` only when you deliberately want fire-and-forget (returns just a jobId immediately) and will follow up yourself later with opencode_job_status — never assume you'll be told when it's done.",
  {
    prompt: z.string().describe("The task/message to send to opencode"),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(540000)
      .optional()
      .describe(
        "Block this call until the job finishes or this many ms elapse (max 540000 = 9 min), returning the full result (text, tokens, cost) instead of just a jobId. Default 0: return immediately without waiting (fire-and-forget — you must poll opencode_job_status yourself, there is no notification when it's done)."
      ),
    tier: z
      .enum(TIER_NAMES)
      .optional()
      .describe(`Intelligence tier to use, cheapest-first. Default "${DEFAULT_TIER}". Ignored if \`model\` is set.`),
    model: z
      .string()
      .optional()
      .describe('Explicit "provider/model" override, e.g. "opencode-go/qwen3.7-max". Takes precedence over `tier`.'),
    variant: z
      .string()
      .optional()
      .describe(
        'Reasoning-effort variant (e.g. "high", "max") to pass with an explicit `model`. Ignored when using `tier` — tiers already carry their own best-scoring variant.'
      ),
    style: z
      .enum(["handoff", "verbose"])
      .optional()
      .describe(
        'Default "handoff": appends an instruction telling opencode to return only the final result, no narrated process. "verbose": sends the prompt as-is, letting the model explain its steps if it wants to.'
      ),
    agent: z.string().optional().describe("Named opencode agent to run as (see `opencode agent`), if any"),
    dir: z.string().optional().describe("Absolute path of the project/directory opencode should work in"),
    files: z.array(z.string()).optional().describe("Absolute file paths to attach to the message"),
    title: z.string().optional().describe("Session title"),
    sessionId: z.string().optional().describe("Existing opencode session id to continue"),
    continueSession: z.boolean().optional().describe("Continue the most recent session"),
    auto: z
      .boolean()
      .optional()
      .describe(
        "Auto-approve tool permissions opencode would otherwise pause for (DANGEROUS: lets it edit/run things unattended). Default false."
      ),
  },
  async ({ tier, model, variant, style, waitMs, ...rest }) => {
    maybeAutoRefreshTiers();
    try {
      const prompt = style === "verbose" ? rest.prompt : rest.prompt + HANDOFF_SUFFIX;
      const usingTier = !model;
      const MAX_ATTEMPTS = 5;
      const attempts = [];

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // Re-resolve every attempt (not just once) so a failure blocked by
        // the previous iteration's onDone callback is already excluded —
        // this walks the fallback pool without needing to index into a
        // band snapshot that could go stale mid-loop.
        const resolved = resolveModel({ model, tier });
        const effectiveVariant = model ? (variant ?? null) : resolved.variant;
        const effectiveTier = usingTier ? (tier ?? DEFAULT_TIER) : null;
        const jobId = startJob({
          ...rest,
          prompt,
          model: resolved.model,
          variant: effectiveVariant,
          tier: effectiveTier,
          onDone: recordJobOutcome,
        });
        attempts.push({ jobId, model: resolved.model, variant: effectiveVariant });

        if (!waitMs) {
          return ok({
            jobId,
            status: "running",
            tier: effectiveTier,
            model: resolved.model,
            variant: effectiveVariant,
            style: style ?? "handoff",
            dir: rest.dir ?? null,
          });
        }

        await waitForJob(jobId, waitMs);
        const summary = jobSummary(getJob(jobId));

        // Only retry on a confirmed failure of a tier-resolved job — an
        // explicit `model` never falls back (the caller chose it on
        // purpose), and "still running" past waitMs is not a failure, it's
        // just slow (e.g. kimi-k3/max legitimately takes 30-60s).
        if (summary.status !== "failed" || !usingTier) {
          return ok(attempts.length > 1 ? { ...summary, attempts } : summary);
        }
        // onDone already blocked this model+variant synchronously before
        // waitForJob resolved (same close/error handler) — next loop
        // iteration's resolveModel call will skip it automatically.
      }

      return err(
        `All ${MAX_ATTEMPTS} candidates for tier "${tier ?? DEFAULT_TIER}" failed. Attempts: ${JSON.stringify(attempts)}`
      );
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_job_status",
  "Check on a job started with opencode_start_job. Returns current status plus whatever output text has streamed in so far. Pass waitMs to block until it finishes (or the timeout elapses) instead of polling repeatedly.",
  {
    jobId: z.string(),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(540000)
      .optional()
      .describe("Milliseconds to wait for completion before returning (max 540000 = 9 min). Default 0 (return immediately)."),
  },
  async ({ jobId, waitMs }) => {
    const job = getJob(jobId);
    if (!job) return err(`No job with id "${jobId}"`);
    if (waitMs) await waitForJob(jobId, waitMs);
    return ok(jobSummary(getJob(jobId)));
  }
);

server.tool(
  "opencode_list_jobs",
  "List all jobs started this server session, with their current status.",
  {},
  async () => {
    return ok({ jobs: listJobs().map(jobSummary) });
  }
);

server.tool(
  "opencode_usage_stats",
  "Aggregate stats across every job this MCP server has ever delegated (persisted at ~/.local/share/opencode-mcp/usage-log.jsonl, survives across sessions/processes — unlike opencode_list_jobs, which only knows this process's in-memory jobs). Reports total tokens, total response characters, and total OpenCode list-price cost per model/tier. `cost` is what the same tokens would have cost pay-per-token — under the Go subscription (flat-rate) or Zen (free) it's $0 actually charged, so this total IS the savings from delegating instead of paying per-token, not a comparison to Claude/Anthropic pricing (this tool has no way to know what the equivalent work would cost in a different model's tokenizer). Pass `sinceHours` to scope to recent jobs only.",
  {
    sinceHours: z
      .number()
      .optional()
      .describe("Only include jobs finished in the last N hours. Default: all recorded history."),
  },
  async ({ sinceHours }) => {
    try {
      let records = readUsageLog();
      if (sinceHours) {
        const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
        records = records.filter((r) => (r.finishedAt ?? 0) >= cutoff);
      }
      return ok(summarizeUsage(records));
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_cancel_job",
  "Cancel a running job.",
  { jobId: z.string() },
  async ({ jobId }) => {
    const found = cancelJob(jobId);
    if (!found) return err(`No job with id "${jobId}"`);
    return ok(jobSummary(getJob(jobId)));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
maybeAutoRefreshTiers();
