#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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
import { runAudit, runInvestigate, runGoal, runJob, MAX_PARTICIPANTS, resolveDefaultMaxConcurrency } from "./orchestrate.js";
import { ALL_LENS_KEYS, DEFAULT_LENS_KEYS, MIN_REPLICAS } from "./lenses.js";
import { runSweep, planSweep, loadSweep, listSweeps, requestSweepCancel } from "./sweep.js";
import { tableOfContents, findSection, fullReadme } from "./help.js";

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
  "opencode_help",
  `Read this server's own README — the design rationale, gotchas, and exact usage instructions for every tool here (including the handoff prompt this repo's own docs give for briefing ANOTHER agent to run opencode_sweep on an unfamiliar project). This is the authoritative source; don't guess at a tool's behavior from its name or from memory of an earlier session — a detail like "why does opencode_goal run sequentially" or "how does the mcp-readonly agent get set up" lives here, not in the tool descriptions.\n\nCall with no arguments first — it returns a table of contents (every heading plus a one-line teaser), costing almost nothing. Then call again with \`section\` matching (even loosely — "sweep", "pin a model", "lens replicas" all resolve) the heading you need; you get back just that section's full text, including its subsections. Pass \`full: true\` only if you genuinely need the entire document at once (it's long).`,
  {
    section: z.string().optional().describe('A heading to fetch, matched loosely (case/backtick/substring/word-overlap insensitive) — e.g. "sweep", "pinning a model", "lens replicas". Omit (with `full` also omitted) to get the table of contents instead.'),
    full: z.boolean().optional().describe("Return the entire README verbatim instead of one section. Default false."),
  },
  async ({ section, full }) => {
    try {
      if (full) return ok({ readme: fullReadme() });
      if (!section) return ok({ tableOfContents: tableOfContents() });
      const { match, suggestions } = findSection(section);
      if (match) return ok({ title: match.title, content: match.content });
      return err(
        suggestions.length
          ? `No single section matched "${section}". Closest headings: ${suggestions.join(" | ")}`
          : `No section matched "${section}" and no close headings were found. Call opencode_help with no arguments to see the table of contents.`
      );
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

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
  "Check the OpenCode Go subscription: confirms the credential is configured and lists the opencode-go models currently on offer (availability/lineup can change). Pass probe:true to also send a trivial ping to the mid/high/max tier models and confirm they're actually responding right now — that costs a small amount of tokens/time, so only do it when you're about to rely on the result (e.g. before delegating a big job), not as a routine check. `defaultMaxConcurrency` reports the concurrency ceiling opencode_audit/opencode_investigate/opencode_sweep fall back to when a call doesn't pass its own `maxConcurrency` — set once at server registration via OPENCODE_MCP_MAX_CONCURRENCY to match what your actual model backend can serve (see README).",
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
        defaultMaxConcurrency: resolveDefaultMaxConcurrency(),
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
  "Send a job (a prompt/task) to OpenCode to work on. Pick a `tier` (low/mid/high/max) instead of a specific model name — tiers are data-driven (see opencode_refresh_tiers): each is the cheapest model within 1% of the best arena score in its cost band on the OpenCode Go subscription (flat-rate, no marginal cost). Default to the lowest tier that can plausibly do the job; only reach for `max` when the task clearly needs the deepest reasoning available. Pass an explicit `model` instead of `tier` only when you specifically need something outside the tier map (see opencode_list_models). Output defaults to a clean hand-off (final result only, no narrated process) — set style:\"verbose\" only if you actually want to see the model's exploration/reasoning (e.g. debugging why a job did something unexpected).\n\nA `tier` pick that fails outright (real error, e.g. region-locked/disabled — not just slow) is automatically retried with the next-best candidate in the same cost pool, and gets excluded from future resolutions with exponential backoff (5min for a first failure, escalating toward 24h only if it keeps failing on repeated real attempts — see opencode_unblock_model to clear that early). This happens on real usage only — there is no separate probing step burning tokens just to check.\n\nIf the OPENCODE_MCP_PIN_MODEL env var is set on this server process, EVERY `tier` resolution uses that fixed model instead (ranking/blocklist bypassed entirely) — set at registration time to force one model for a whole session; check opencode_check_go_status's `pinnedModel` field to see if that's active right now. The pin is a HARD override: it wins even over an explicit `model` param, specifically so that if you forget it's pinned and ask for a different model by name (or via `tier`), you still get the pinned one — but the response's `warning` field will say so, so it's never silent. No `warning` field means nothing was overridden.\n\nIMPORTANT — there is no push notification when a job finishes: MCP tool calls are strictly request/response, this server cannot interrupt the conversation on its own, and nothing resembling the native run_in_background task-notification exists here. Pass `waitMs` (recommended for most jobs — up to 540000ms/9min) to block this single call until the job actually finishes and get the full result back directly (also required for the automatic fallback above to retry within this same call). Omit `waitMs` only when you deliberately want fire-and-forget (returns just a jobId immediately) and will follow up yourself later with opencode_job_status — never assume you'll be told when it's done.",
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
      // A pin forces the model regardless of what was asked for, so it never
      // behaves like a genuine tier resolution (no fallback pool, no point
      // blocking it on failure — the next call would just get forced back to
      // the same pinned model anyway).
      const usingTier = !model && !pinnedModel();
      const MAX_ATTEMPTS = 5;
      const attempts = [];
      let warning;

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // Re-resolve every attempt (not just once) so a failure blocked by
        // the previous iteration's onDone callback is already excluded —
        // this walks the fallback pool without needing to index into a
        // band snapshot that could go stale mid-loop.
        const resolved = resolveModel({ model, variant, tier });
        warning = resolved.warning ?? warning;
        const effectiveTier = usingTier ? (tier ?? DEFAULT_TIER) : null;
        const jobId = startJob({
          ...rest,
          prompt,
          model: resolved.model,
          variant: resolved.variant,
          tier: effectiveTier,
          onDone: recordJobOutcome,
        });
        attempts.push({ jobId, model: resolved.model, variant: resolved.variant });

        if (!waitMs) {
          return ok({
            jobId,
            status: "running",
            tier: effectiveTier,
            model: resolved.model,
            variant: resolved.variant,
            style: style ?? "handoff",
            dir: rest.dir ?? null,
            ...(warning ? { warning } : {}),
          });
        }

        await waitForJob(jobId, waitMs);
        const summary = jobSummary(getJob(jobId));

        // Only retry on a confirmed failure of a tier-resolved job — an
        // explicit `model` never falls back (the caller chose it on
        // purpose), and "still running" past waitMs is not a failure, it's
        // just slow (e.g. kimi-k3/max legitimately takes 30-60s).
        if (summary.status !== "failed" || !usingTier) {
          const result = attempts.length > 1 ? { ...summary, attempts } : summary;
          if (warning) result.warning = warning;
          return ok(result);
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
  "Check on a job started with opencode_start_job. Returns current status plus whatever output text has streamed in so far. Pass waitMs to block until it finishes (or the timeout elapses) instead of polling repeatedly. Works even for a job this server process didn't start itself (a prior process that restarted, or a different Claude Code session) — every job's state is checkpointed to disk on each step and read back from there if it's not in this process's memory, so a server restart doesn't turn a job irrecoverable.",
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

const DEFAULT_RESUME_MESSAGE =
  "Parece que hubo una interrupción (corte de red o error transitorio), no un problema con la tarea en sí. " +
  "Continuá el trabajo exactamente desde donde quedaste — no repitas pasos ya hechos ni vuelvas a leer " +
  "archivos que ya leíste, salvo que necesites confirmar algo puntual. Si ya habías terminado, decime " +
  "directamente el resultado final.";

server.tool(
  "opencode_resume_job",
  'Nudge a specific opencode SESSION to continue instead of starting fresh — the same recovery you\'d do by hand in the opencode TUI ("busco la sesión, le mando un mensaje de que hubo un error, y sigue donde quedó"), just callable from here. Useful when a job seems to have gone in circles, lost context, or you suspect a transient hiccup derailed it, and starting over would waste the progress it already made.\n\nPass `jobId` to resume a job by id — this works even if a different process started it or the server has since restarted (job state is checkpointed to disk, read back automatically); reuses its `model`/`variant`/`dir` unless you override them. Pass `sessionId` directly instead if you only have that (e.g. from `opencode session list`) and no jobId — in that case `model`/`variant` are optional since opencode reuses whatever the session already had, but `dir` is needed unless it\'s the current working directory. `message` defaults to a generic "there was a network hiccup, continue where you left off, don\'t repeat finished work" nudge — override it with something specific if you know what actually went wrong. This starts a genuinely new job (new jobId) continuing that session\'s existing conversation, not a new unrelated one — pass `waitMs` same as opencode_start_job.',
  {
    jobId: z.string().optional().describe("A jobId this server process already knows about (from a prior opencode_start_job call this session). Provide this OR sessionId."),
    sessionId: z.string().optional().describe('opencode\'s own session id (e.g. "ses_...") to continue directly — works even for a job from a different process/session. Provide this OR jobId.'),
    message: z.string().optional().describe("Nudge prompt. Defaults to a generic transient-interruption recovery message if omitted."),
    dir: z.string().optional().describe("Working directory for the session. Required if sessionId is given without a resolvable jobId; inferred from the job otherwise."),
    model: z.string().optional().describe('Explicit "provider/model" override. Optional — omit to let opencode reuse whichever model the session already had.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model override."),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(540000)
      .optional()
      .describe("Block until this resume job finishes or this many ms elapse (max 540000 = 9 min), same as opencode_start_job. Default 0: fire-and-forget."),
  },
  async ({ jobId, sessionId, message, dir, model, variant, waitMs }) => {
    try {
      const priorJob = jobId ? getJob(jobId) : null;
      if (jobId && !priorJob) return err(`No job with id "${jobId}" found (checked both this process's memory and its disk checkpoint) — pass sessionId directly instead.`);

      const resolvedSessionId = sessionId ?? priorJob?.sessionId;
      if (!resolvedSessionId) {
        return err(
          priorJob
            ? `Job "${jobId}" never got a sessionId from opencode (it may have failed before establishing one) — nothing to resume.`
            : "Provide either jobId or sessionId."
        );
      }

      const resolvedDir = dir ?? priorJob?.dir;
      const resolvedModel = model ?? priorJob?.model;
      const resolvedVariant = model ? (variant ?? null) : (priorJob?.variant ?? null);

      const newJobId = startJob({
        prompt: message || DEFAULT_RESUME_MESSAGE,
        sessionId: resolvedSessionId,
        dir: resolvedDir,
        model: resolvedModel,
        variant: resolvedVariant,
      });

      if (waitMs) {
        await waitForJob(newJobId, waitMs);
        return ok(jobSummary(getJob(newJobId)));
      }
      return ok({ jobId: newJobId, status: "running", resumedSessionId: resolvedSessionId, dir: resolvedDir ?? null });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_list_jobs",
  "List all jobs started this server session, with their current status. Unlike opencode_job_status/opencode_resume_job (which fall back to disk), this only lists what THIS process has in memory — jobs from a prior process/restart won't appear here even though they're individually still look-up-able by jobId.",
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

const ORCHESTRATION_WAIT_MS = 480000; // 8 min per participant — leaves headroom under the 9-min per-job cap

server.tool(
  "opencode_audit",
  `Fan out N (default 16, wider — up to 24 — when the free local pinned model is active; stays at this default otherwise, max ${MAX_PARTICIPANTS}) independent read-only reviewers over a diff — by default the CURRENT uncommitted changes (\`git diff HEAD\` in \`dir\`), or everything since \`baseCommit\` when given (review a whole branch/PR instead of just what's uncommitted). Computed once by this tool, not left for each agent to run itself. If the diff is large (~100k+ tokens), participants stop getting the full diff and instead each review a distinct subset of the changed files independently (still parallel, just partitioned). Each reviewer is forced onto a dedicated "mcp-readonly" opencode agent (registered in opencode.jsonc with edit/bash/task/skill all denied at the permission-engine level — a real guarantee, not a prompt request) and assigned a rotating lens (correctness, security, simplification, efficiency, tests, consistency, error handling, readability) so N reviews of the same diff under the same model actually diverge instead of duplicating each other.\n\nReconciliation: one aggregator reads all N participants' findings and builds a single report, explicitly noting how many participants corroborated each finding (2+ = confirmed, 1 = low confidence — not silently trusted). Then, \`depth\` times (default 1), a FRESH batch of N adversarial reviewers gets ONLY that report plus the framing "a low-confidence agent reported this, your job is to determine its falseness" — each independently tries to refute the low-confidence items using its own read-only access to the code — and one more aggregator reconciles [previous report + all adversarial reviews] into an updated report, promoting anything that survived (labeled "adversarially confirmed") and calling out (never silently dropping) anything refuted. \`depth=0\` skips the adversarial step entirely; \`depth=2\` repeats the whole adversarial-round-then-reaggregate step twice, for higher-criticality reviews. Returns the final report text plus per-round job metadata. If there are no changes, returns immediately with no jobs spawned.\n\nDefault output is LEAN: \`participants\` entries carry status/tokens/cost only, never the underlying prompt — echoing the full diff back once per participant is pure bloat (observed 2026-08-19: 650KB of a 773KB response was duplicated prompts, next to a 5KB actual answer). \`reconciliation.report\` is always the real answer, always returned in full. Pass \`verbose: true\` to also get each participant's raw findings text.`,
  {
    lenses: z.union([z.literal("all"), z.array(z.enum(ALL_LENS_KEYS))]).optional().describe(`Which QA lenses to run. Omit for the 6 core lenses (${DEFAULT_LENS_KEYS.join(", ")}); pass "all" for every lens including ${ALL_LENS_KEYS.filter((k) => !DEFAULT_LENS_KEYS.includes(k)).join(", ")}; or pass an explicit subset.`),
    replicas: z.number().int().min(MIN_REPLICAS).optional().describe(`How many INDEPENDENT reviewers each selected lens gets. Default ${MIN_REPLICAS}, minimum ${MIN_REPLICAS} — corroboration is what makes the confidence ranking mean anything, so a lens is never reviewed only once. Total participants = lenses x replicas (clamped to MAX_PARTICIPANTS). Prefer raising this over \`count\`.`),
    count: z.number().int().min(1).max(MAX_PARTICIPANTS).optional().describe(`LEGACY: exact total participants, round-robined across lenses (uneven coverage — some lenses get more reviewers than others). Overrides \`replicas\` when set. Prefer \`replicas\`.`),
    contextFile: z.string().optional().describe("Path to a file describing the project's domain/architecture, prepended to every reviewer's prompt. Omit to auto-detect AGENTS.md / CLAUDE.md / CONTRIBUTING.md / README.md in `dir`."),
    dir: z.string().optional().describe("Absolute path of the git repo to audit. Defaults to this server's cwd."),
    baseCommit: z.string().optional().describe('Review everything since this commit ("git diff <baseCommit> HEAD") instead of just uncommitted changes — e.g. to review a whole feature branch/PR.'),
    focus: z.string().optional().describe("Optional extra instruction appended to every reviewer's prompt (e.g. \"pay special attention to the auth changes\")."),
    tier: z.enum(TIER_NAMES).optional().describe(`Tier for every participant AND every aggregator/adversarial job. Default "${DEFAULT_TIER}". Ignored if \`model\` is set or a pin is active.`),
    model: z.string().optional().describe('Explicit "provider/model" override for every participant and reconciliation job.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model."),
    waitMs: z.number().int().min(1000).max(540000).optional().describe(`Per-job wait cap. Default ${ORCHESTRATION_WAIT_MS}.`),
    depth: z.number().int().min(0).max(3).optional().describe(`Adversarial-round-then-reaggregate repetitions (default 1). 0 skips adversarial verification entirely (fastest/cheapest); 1 = one round; 2 = two rounds for higher-criticality reviews (more rigor, more cost).`),
    groupSize: z.number().int().min(2).optional().describe("How many sources (participant findings, or adversarial reviews) each single aggregator call digests before its output is merged with sibling groups' — a TREE reduction instead of one aggregator reading every participant at once. Default 4. Lower this if you have many replicas/lenses and see aggregation timing out or coming back empty (a flat aggregator's prompt scales with participant count x output length); raising it trades fewer, larger aggregator calls for less merge overhead. Leaf-level groups run in parallel regardless of this value."),
    maxConcurrency: z.number().int().min(1).optional().describe("Max opencode processes running AT ONCE against the model backend, regardless of total participant/replica count. Default 4, or OPENCODE_MCP_MAX_CONCURRENCY if set at server registration (see README) — set that once to your backend's real capacity instead of passing this on every call. This is the actual fix for aggregation timing out at high replica counts — groupSize bounds prompt SIZE, this bounds request VOLUME; a single local backend serving 40+ simultaneous requests just queues them, and queueing time (not prompt size) is what blows through waitMs. Lower it further if you're seeing 'Unexpected server error' responses (backend overload) or a local model that's otherwise being used for other things at the same time."),
    verbose: z.boolean().optional().describe("Default false: participants carry only status/tokens/cost, never the underlying prompt. Set true to also include each participant's own raw findings text — useful for debugging the reconciliation, not needed for normal use."),
  },
  async ({ count, replicas, lenses, groupSize, maxConcurrency, contextFile, dir, baseCommit, focus, tier, model, variant, waitMs, depth, verbose }) => {
    try {
      return ok(await runAudit({ count, replicas, lenses, groupSize, maxConcurrency, contextFile, dir, baseCommit, focus, tier, model, variant, waitMs: waitMs ?? ORCHESTRATION_WAIT_MS, depth: depth ?? 1, verbose: verbose ?? false }));
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_investigate",
  `Same read-only fan-out / confidence-ranked reconciliation shape as opencode_audit, but driven by an arbitrary \`prompt\` instead of a git diff — use this to have several independent agents investigate ONE question/topic in parallel and get back one reconciled answer grounded in evidence. Fans out N (default 5, wider — up to 16 — when the free local pinned model is active; stays at this default otherwise, max ${MAX_PARTICIPANTS}) participants, each forced onto the "mcp-readonly" agent (edit/bash/task/skill denied at the permission level) with a light diversifier nudge so they don't just duplicate each other's angle.\n\nReconciliation: one aggregator builds a single report from all N participants' findings, explicitly noting how many corroborated each finding (2+ = confirmed, 1 = low confidence). Then, \`depth\` times (default 1), a FRESH batch of N adversarial reviewers gets ONLY that report plus the framing "a low-confidence agent reported this, your job is to determine its falseness" and independently tries to refute the low-confidence items — one more aggregator then reconciles [previous report + adversarial reviews] into an updated report, promoting survivors ("adversarially confirmed") and calling out (never silently dropping) anything refuted. \`depth=0\` skips adversarial verification; \`depth=2\` repeats the round twice for higher-criticality investigations. Returns the final report text plus per-round job metadata.\n\nDefault output is LEAN: \`participants\` entries carry status/tokens/cost only, never the underlying prompt. \`reconciliation.report\` is always the real answer, always returned in full. Pass \`verbose: true\` to also get each participant's raw findings text.`,
  {
    prompt: z.string().describe("The question/topic every participant investigates independently."),
    count: z.number().int().min(1).max(MAX_PARTICIPANTS).optional().describe("Number of parallel investigators (reused as the adversarial-round size too). Default 5 (wider — up to 16 — when the free local pinned model is active; stays at this default otherwise)."),
    dir: z.string().optional().describe("Absolute path of the project directory. Defaults to this server's cwd."),
    tier: z.enum(TIER_NAMES).optional().describe(`Tier for every participant AND every aggregator/adversarial job. Default "${DEFAULT_TIER}". Ignored if \`model\` is set or a pin is active.`),
    model: z.string().optional().describe('Explicit "provider/model" override for every participant and reconciliation job.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model."),
    waitMs: z.number().int().min(1000).max(540000).optional().describe(`Per-job wait cap. Default ${ORCHESTRATION_WAIT_MS}.`),
    depth: z.number().int().min(0).max(3).optional().describe(`Adversarial-round-then-reaggregate repetitions (default 1). 0 skips adversarial verification entirely (fastest/cheapest); 1 = one round; 2 = two rounds for higher-criticality investigations (more rigor, more cost).`),
    groupSize: z.number().int().min(2).optional().describe("How many sources each single aggregator call digests before merging with sibling groups — a tree reduction instead of one aggregator reading every participant at once. Default 4."),
    maxConcurrency: z.number().int().min(1).optional().describe("Max opencode processes running AT ONCE against the model backend, regardless of total participant count. Default 4, or OPENCODE_MCP_MAX_CONCURRENCY if set at server registration (see README). The actual fix for aggregation timing out at high counts (groupSize bounds prompt size, this bounds request volume against a backend that can't usefully serve many requests at once)."),
    verbose: z.boolean().optional().describe("Default false: participants carry only status/tokens/cost, never the underlying prompt. Set true to also include each participant's own raw findings text."),
  },
  async ({ prompt, count, groupSize, maxConcurrency, dir, tier, model, variant, waitMs, depth, verbose }) => {
    try {
      return ok(await runInvestigate({ prompt, count, groupSize, maxConcurrency, dir, tier, model, variant, waitMs: waitMs ?? ORCHESTRATION_WAIT_MS, depth: depth ?? 1, verbose: verbose ?? false }));
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_goal",
  `Work toward a \`goal\` across N (default 3, max ${MAX_PARTICIPANTS}) SEQUENTIAL passes — never parallel, since these agents actually edit code and running them concurrently in the same working tree would corrupt each other's changes. (An earlier version of this tool ran independent parallel attempts judged by a panel — reverted after real testing showed the judge panel, being the same weak model, rejecting genuinely correct candidates more often than it should have.) Pass 1 attempts the goal fresh; each later pass continues the PREVIOUS pass's own opencode session (iterative refinement, told not to repeat finished work).\n\nAfter EVERY pass, real \`lint\`/\`test\` commands run against \`dir\` (mechanical ground truth, not another LLM opinion) and their actual pass/fail output is attached to the NEXT pass's prompt — this is the main defense against a weak model trusting its own "done!" self-report. Commands default to \`npm run lint\`/\`npm test\` when \`dir\`'s package.json declares those scripts; pass \`lintCommand\`/\`testCommand\` to override, or explicit \`null\` to force-disable one. These passes are NOT read-only (that's the point). Once every pass has finished, one final read-only "mcp-readonly" pass inspects the repo's actual current state itself (not just self-reports) and returns ONE consolidated verification report: was the goal actually met, what changed, any concerns/regressions, anything left undone, and whether lint/tests pass now.\n\nDefault output is LEAN: each pass entry carries status/tokens/cost/checks only, never the underlying prompt (which for later passes would otherwise duplicate the previous pass's full lint/test output). \`verification.text\` — the actual consolidated report — is always returned in full. Pass \`verbose: true\` to also get each pass's own raw response text.`,
  {
    goal: z.string().describe("The task/goal to work toward."),
    passes: z.number().int().min(1).max(MAX_PARTICIPANTS).optional().describe("Number of sequential passes. Default 3."),
    lintCommand: z.string().nullable().optional().describe("Shell command to run after every pass (e.g. \"npm run lint\"). Omit to auto-detect from `dir`'s package.json `scripts.lint`; pass explicit `null` to force-disable."),
    testCommand: z.string().nullable().optional().describe("Shell command to run after every pass (e.g. \"npm test\"). Omit to auto-detect from `dir`'s package.json `scripts.test`; pass explicit `null` to force-disable."),
    checkTimeoutMs: z.number().int().min(1000).optional().describe("Timeout for each lint/test command. Default 180000 (3 min)."),
    dir: z.string().optional().describe("Absolute path of the project directory. Defaults to this server's cwd."),
    agent: z.string().optional().describe("Named opencode agent every working pass should run as (NOT the verifier, which always uses mcp-readonly)."),
    tier: z.enum(TIER_NAMES).optional().describe(`Tier for every pass AND the verifier. Default "${DEFAULT_TIER}". Ignored if \`model\` is set or a pin is active.`),
    model: z.string().optional().describe('Explicit "provider/model" override for every pass and the verifier.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model."),
    waitMs: z.number().int().min(1000).max(540000).optional().describe(`Per-job wait cap. Default ${ORCHESTRATION_WAIT_MS}.`),
    verbose: z.boolean().optional().describe("Default false: pass entries carry only status/tokens/cost/checks, never the underlying prompt. Set true to also include each pass's own raw response text."),
  },
  async ({ goal, passes, lintCommand, testCommand, checkTimeoutMs, dir, agent, tier, model, variant, waitMs, verbose }) => {
    try {
      return ok(await runGoal({ goal, passes, lintCommand, testCommand, checkTimeoutMs, dir, agent, tier, model, variant, waitMs: waitMs ?? ORCHESTRATION_WAIT_MS, verbose: verbose ?? false }));
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_job",
  `Runs opencode_goal (sequential passes, default 3, with real lint/test output fed to each next pass) to achieve a goal, then immediately runs opencode_audit (confidence-ranked adversarial QA review) on whatever uncommitted changes resulted. The goal passes leave edits uncommitted in \`dir\`; audit reads \`git diff HEAD\` in that same dir and reviews them. Returns BOTH results — the goal's pass reports + verification, and the audit's confidence-ranked findings — verbatim, without interpreting anything or deciding what's serious. It is the CALLER (the orchestrator) that reads the QA findings and decides whether to send another goal round to address them, stop here, or something else.\n\nDefault \`qaCount\` is 8 (wider — up to 16 — when the free local pinned model is active; stays at this default otherwise, smaller than opencode_audit's own default of 16 — this is a fast complexity-appropriate check right after a goal run, not an exhaustive audit). Default \`qaDepth\` is 1. Pass \`model\`, \`variant\`, \`tier\`, \`waitMs\`, or \`agent\` to forward them to both sub-steps.\n\nDefault output is LEAN throughout (see opencode_goal/opencode_audit) — pass \`verbose: true\` to get raw text from every pass and every QA participant too.`,
  {
    goal: z.string().describe("The task/goal to work toward."),
    passes: z.number().int().min(1).max(MAX_PARTICIPANTS).optional().describe("Sequential passes for the goal step. Default 3."),
    lintCommand: z.string().nullable().optional().describe("Shell command to run after every goal pass. Omit to auto-detect from `dir`'s package.json `scripts.lint`; pass explicit `null` to force-disable."),
    testCommand: z.string().nullable().optional().describe("Shell command to run after every goal pass. Omit to auto-detect from `dir`'s package.json `scripts.test`; pass explicit `null` to force-disable."),
    checkTimeoutMs: z.number().int().min(1000).optional().describe("Timeout for each lint/test command. Default 180000 (3 min)."),
    qaCount: z.number().int().min(1).max(MAX_PARTICIPANTS).optional().describe("Number of QA reviewers. Default 8 (wider — up to 16 — when the free local pinned model is active; stays at this default otherwise)."),
    qaDepth: z.number().int().min(0).max(3).optional().describe("Adversarial-round-then-reaggregate depth for the QA step (default 1). 0 skips adversarial verification."),
    dir: z.string().optional().describe("Absolute path of the project directory. Defaults to this server's cwd."),
    agent: z.string().optional().describe("Named opencode agent every working pass should run as (NOT the QA verifier)."),
    tier: z.enum(TIER_NAMES).optional().describe(`Tier for every pass AND every QA participant/aggregator. Default "${DEFAULT_TIER}". Ignored if \`model\` is set or a pin is active.`),
    model: z.string().optional().describe('Explicit "provider/model" override for every pass and QA job.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model."),
    waitMs: z.number().int().min(1000).max(540000).optional().describe(`Per-job wait cap. Default ${ORCHESTRATION_WAIT_MS}.`),
    verbose: z.boolean().optional().describe("Default false: no raw prompts, no per-pass/per-participant raw text. Set true to include it for debugging."),
  },
  async ({ goal, passes, lintCommand, testCommand, checkTimeoutMs, qaCount, qaDepth, dir, agent, tier, model, variant, waitMs, verbose }) => {
    try {
      return ok(await runJob({ goal, passes, lintCommand, testCommand, checkTimeoutMs, qaCount, qaDepth, dir, agent, tier, model, variant, waitMs: waitMs ?? ORCHESTRATION_WAIT_MS, verbose: verbose ?? false }));
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

// Sweeps outlive the tool call that starts them (a whole-repo sweep runs for
// an hour or more, far past any MCP client's request timeout), so they run
// detached here and are polled via opencode_sweep_status. State is
// checkpointed to disk after every segment, so a partial sweep survives even
// this process dying — same convention as job-store.js.
const runningSweeps = new Map();

server.tool(
  "opencode_sweep",
  `Audit an ENTIRE codebase, not just a diff. Segments the repo into token-budgeted chunks, runs the full lens swarm (see opencode_audit) over each segment in turn, and accumulates confirmed findings into a ledger that is injected into every LATER segment — so reviewers stop re-reporting known bugs and instead hunt for OTHER instances of the same bug class. Refuted findings are carried forward too, so a false positive dismissed in segment 3 isn't re-litigated in segment 12.\n\nSegments are packed by PATH, not by size, so a directory stays together and cross-file defects (caller vs callee, two symmetric paths updated inconsistently) are visible within one segment. A segment is a STARTING POINT, not a cage: reviewers are told to follow a flow across any other file in the repo when tracing it end-to-end is what the lens requires.\n\nFile selection is language-agnostic and yours to control: \`sourceExtensions\` picks what counts as source, \`includeGlobs\`/\`excludeGlobs\` narrow it further, and generated files are detected both by pattern (\`*.g.*\`, \`*.pb.*\`, \`*.generated.*\`, lockfiles, vendor/build dirs) and by sniffing for \`@generated\`-style headers in any language. ALWAYS run with \`plan: true\` first — it returns the file/segment breakdown and job estimate for free, with no agents spawned, so you can fix your filters before committing to a run that takes an hour.\n\nThis tool RETURNS IMMEDIATELY with a \`sweepId\`; the sweep continues in the background. Poll opencode_sweep_status for progress and the final report. A full markdown report is rewritten to disk after every segment, so partial results are always recoverable. Call opencode_sweep_cancel with the \`sweepId\` to stop a sweep that's misbehaving or no longer needed — it stops promptly rather than only between segments, and there is no other way to stop one short of restarting this whole MCP server.`,
  {
    dir: z.string().optional().describe("Absolute path of the repo to sweep. Defaults to this server's cwd."),
    plan: z.boolean().optional().describe("If true, spawn NOTHING — just return which files/segments would be reviewed plus a job estimate. Run this first, always."),
    verbose: z.boolean().optional().describe("With `plan: true` only: include each segment's full file-path list. Default false — segments carry just fileCount/approxTokens plus a 3-file sample, since the full list on a large repo can be hundreds of KB on its own; ignored when `plan` is not set."),
    lenses: z.union([z.literal("all"), z.array(z.enum(ALL_LENS_KEYS))]).optional().describe(`Which QA lenses to run. Omit for the 6 core lenses; "all" for every lens (${ALL_LENS_KEYS.length} total); or an explicit subset.`),
    replicas: z.number().int().min(MIN_REPLICAS).optional().describe(`Independent reviewers per lens, per segment. Default ${MIN_REPLICAS}, minimum ${MIN_REPLICAS}. Multiplies total runtime — check the \`plan\` estimate before raising it.`),
    depth: z.number().int().min(0).max(3).optional().describe("Adversarial verification rounds per segment (default 1). 0 is much faster and much noisier across a whole repo; 1 is the sane default here."),
    groupSize: z.number().int().min(2).optional().describe("How many participant/adversary outputs each single aggregator call digests before merging with sibling groups — a tree reduction instead of one aggregator reading everyone at once. Default 4. Lower this if segments come back with an empty report (the flat aggregator's prompt scales with lenses x replicas x output length and can outrun waitMs at high replica counts)."),
    maxConcurrency: z.number().int().min(1).optional().describe("Max opencode processes running AT ONCE per segment, regardless of lenses x replicas. Default 4, or OPENCODE_MCP_MAX_CONCURRENCY if set at server registration (see README). This is the actual fix for a segment's aggregation never finishing at high replica counts: groupSize bounds prompt SIZE, this bounds request VOLUME against the model backend — a local server serving 40+ simultaneous requests just queues them, and that queueing (not prompt size) is what exhausts waitMs. Observed 2026-08-22: replicas:4 (48 participants/segment) with the default concurrency produced 21/21 segments incomplete or failed over 5h42m; lowering this is the fix, not raising waitMs."),
    budgetTokens: z.number().int().min(4000).optional().describe("Approx token budget per segment (default 40000). Lower = more, smaller segments = slower but more focused."),
    includeGlobs: z.array(z.string()).optional().describe('Restrict the sweep to paths matching these globs, e.g. ["lib/**", "src/**"]. Supports ** and *.'),
    excludeGlobs: z.array(z.string()).optional().describe("Extra globs to exclude, on top of the built-in vendor/build/generated/lockfile defaults."),
    sourceExtensions: z.array(z.string()).optional().describe('Override what counts as reviewable source, e.g. [".dart"] or [".ts", ".tsx"]. Omit for a broad multi-language default.'),
    skipGeneratedSniff: z.boolean().optional().describe("Skip reading each file's header to detect @generated markers. Faster discovery, but generated code may slip in."),
    maxSegments: z.number().int().min(1).optional().describe("Hard cap on segments reviewed — useful to trial the first N segments of a big repo before committing to all of it."),
    contextFile: z.string().optional().describe("Project/domain context file prepended to every reviewer's prompt. Omit to auto-detect AGENTS.md / CLAUDE.md / CONTRIBUTING.md / README.md."),
    focus: z.string().optional().describe("Extra instruction appended to every reviewer's prompt across all segments."),
    tier: z.enum(TIER_NAMES).optional().describe(`Tier for every job in the sweep. Default "${DEFAULT_TIER}". Ignored if \`model\` is set or a pin is active.`),
    model: z.string().optional().describe('Explicit "provider/model" override for every job in the sweep.'),
    variant: z.string().optional().describe("Reasoning-effort variant to pair with an explicit model."),
    waitMs: z.number().int().min(1000).max(540000).optional().describe(`Per-JOB wait cap (not per sweep). Default ${ORCHESTRATION_WAIT_MS}.`),
  },
  async ({ plan, verbose, dir, lenses, replicas, depth, groupSize, maxConcurrency, budgetTokens, includeGlobs, excludeGlobs, sourceExtensions, skipGeneratedSniff, maxSegments, contextFile, focus, tier, model, variant, waitMs }) => {
    try {
      const common = { dir, lenses, replicas, depth: depth ?? 1, groupSize, maxConcurrency, budgetTokens, includeGlobs, excludeGlobs, sourceExtensions, skipGeneratedSniff, maxSegments, contextFile, focus, tier, model, variant, waitMs: waitMs ?? ORCHESTRATION_WAIT_MS };
      if (plan) return ok({ plan: true, ...planSweep({ ...common, verbose }) });

      const preview = planSweep(common);
      if (!preview.segmentCount) {
        return err(`No reviewable source files found in ${preview.dir}. Check includeGlobs/excludeGlobs/sourceExtensions — ${preview.skipped.notSource} file(s) were skipped as non-source and ${preview.skipped.excluded} as excluded.`);
      }

      // Id is minted HERE, not inside runSweep, so the caller is guaranteed a
      // pollable id no matter when the background run first checkpoints.
      const sweepId = randomUUID();
      // Detached on purpose — see the comment above runningSweeps.
      runSweep({
        ...common,
        sweepId,
        onUpdate: (state) => runningSweeps.set(state.sweepId, state),
      }).catch((e) => {
        console.error("[opencode-mcp] sweep crashed:", e?.message ?? e);
      });

      return ok({
        sweepId,
        status: "running",
        message: "Sweep started in the background. Poll opencode_sweep_status with this sweepId; the markdown report on disk is rewritten after every segment.",
        totalSegments: preview.segmentCount,
        fileCount: preview.fileCount,
        lenses: preview.lenses,
        replicas: preview.replicas,
        estimatedJobs: preview.estimatedJobs,
        skipped: preview.skipped,
      });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_sweep_status",
  "Check a sweep started with opencode_sweep. Returns progress (segments done / total), the accumulated confirmed-findings ledger, and the path to the full markdown report on disk (rewritten after every segment, so it's useful long before the sweep finishes). Reads from disk, so it works across a server restart or from a different session. Omit `sweepId` to list all known sweeps newest-first.\n\nDefault output is LEAN and built for repeated polling: a `segmentCounts` breakdown by status, plus a `segments` array containing ONLY segments that have actually started (never the still-`pending` ones — on a large sweep those are most of them and carry zero information until their turn comes). Each active segment's `phase` field updates LIVE, not just at segment boundaries — e.g. \"Reviewing: 12/48 participant(s) finished\", \"Aggregating (adversarial round 1): level 0, 3/6 group(s) done\" — so a segment sitting at status `running` for a long time is distinguishable from a hung one on every single poll, not just when it finally completes. Pass `verbose: true` to also get every `pending` segment listed, the raw `phaseDetail` event behind the phase string, and each active segment's full reconciled report text.",
  {
    sweepId: z.string().optional().describe("The sweep to check. Omit to list every known sweep instead."),
    verbose: z.boolean().optional().describe("Default false: segments array excludes still-pending segments, no report text. Set true to include pending segments too and each segment's full report text — the report file on disk already has all of it, so this is rarely needed."),
  },
  async ({ sweepId, verbose }) => {
    try {
      if (!sweepId) return ok({ sweeps: listSweeps() });
      const state = runningSweeps.get(sweepId) ?? loadSweep(sweepId);
      if (!state) return err(`No sweep with id "${sweepId}" (checked memory and ${"~/.local/share/opencode-mcp/sweeps"}).`);

      const segmentCounts = state.segments.reduce(
        (acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }),
        { pending: 0, running: 0, completed: 0, incomplete: 0, failed: 0 }
      );
      const visibleSegments = verbose ? state.segments : state.segments.filter((s) => s.status !== "pending");

      return ok({
        sweepId: state.sweepId,
        dir: state.dir,
        status: state.status,
        completedSegments: state.completedSegments,
        totalSegments: state.totalSegments,
        segmentCounts,
        fileCount: state.fileCount,
        lenses: state.lensKeys,
        replicas: state.replicas,
        depth: state.depth,
        projectContextFile: state.projectContextFile,
        reportPath: state.reportPath,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        error: state.error,
        confirmedFindings: state.ledger,
        segments: visibleSegments.map((s) => ({
          index: s.index,
          status: s.status,
          phase: s.phase ?? null,
          fileCount: s.files.length,
          approxTokens: s.approxTokens,
          findingCount: s.findings?.length ?? 0,
          error: s.error,
          ...(verbose ? { report: s.report, phaseDetail: s.phaseDetail ?? null } : {}),
        })),
      });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

server.tool(
  "opencode_sweep_cancel",
  "Stop a sweep started with opencode_sweep. Before this existed, the only way to stop a misbehaving or no-longer-needed sweep was to kill the entire MCP server process, taking every other tool down with it for the rest of the session — observed 2026-08-22 needing exactly that after a sweep ran 5h42m without a single segment completing successfully. This checks cooperatively: it stops the sweep from starting its next segment, AND stops its current segment's concurrency-limited dispatch from picking up any new work — so it typically responds within one wave (bounded by `maxConcurrency`) rather than only at the next segment boundary. Whatever's already mid-flight in that last wave still runs to its own completion or waitMs, same as any other job. Poll opencode_sweep_status afterward to confirm `status` reached `cancelled`.",
  {
    sweepId: z.string().describe("The sweep to cancel."),
  },
  async ({ sweepId }) => {
    try {
      const inMemory = runningSweeps.has(sweepId);
      const state = runningSweeps.get(sweepId) ?? loadSweep(sweepId);
      if (!state) return err(`No sweep with id "${sweepId}" (checked memory and ${"~/.local/share/opencode-mcp/sweeps"}).`);
      if (state.status !== "running") return ok({ sweepId, status: state.status, message: `Sweep is already ${state.status}, nothing to cancel.` });
      // Cancellation is an in-process signal (same constraint as opencode_cancel_job)
      // — it only actually stops the sweep if IT is what's running the loop.
      if (!inMemory) {
        return err(
          `Sweep "${sweepId}" is on disk as "running" but is not tracked by THIS server process — it's either running under a different Claude Code session's opencode-mcp process, or its process already died without updating its final status. Cancellation only works against the process actually running the loop; find and cancel it from that session, or if the process is gone, treat this sweep as stalled.`
        );
      }
      requestSweepCancel(sweepId);
      return ok({ sweepId, status: "cancelling", message: "Cancellation requested. Poll opencode_sweep_status — status will reach 'cancelled' once the current wave of in-flight jobs finishes (bounded by maxConcurrency), typically well before the current segment itself would have finished." });
    } catch (e) {
      return err(String(e.message ?? e));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
maybeAutoRefreshTiers();
