#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listProviders, listModels, modelInfo } from "./catalog.js";
import { startJob, getJob, listJobs, cancelJob, waitForJob, jobSummary } from "./jobs.js";
import { TIER_NAMES, DEFAULT_TIER, getTierMap, getTierMapMeta, saveTierMap, resolveModel, isStale } from "./tiers.js";
import { computeTierMap, toTierEntry } from "./rank.js";

/**
 * A model can score well on the leaderboard and still be unusable right now
 * (observed: region-locked models return a 403 with no output). Probe each
 * band's top candidate with a trivial prompt and fall through to the next
 * one in the same cost band if it fails, instead of saving a tier pick that
 * silently breaks every job that uses it.
 */
async function validateTierPick(name, band) {
  for (const candidate of band) {
    const jobId = startJob({ prompt: "Reply with exactly: OK", model: candidate.model, variant: candidate.variant });
    await waitForJob(jobId, 20000);
    const s = jobSummary(getJob(jobId));
    if (s.status === "completed") {
      return { entry: toTierEntry(name, candidate), verified: true };
    }
  }
  // Whole band failed to respond — fall back to its top pick anyway (best
  // information available) but flag it clearly rather than hiding the issue.
  return { entry: toTierEntry(name, band[0]), verified: false };
}

/**
 * Mark a tier's final winner as `inherited` when a strictly cheaper tier's
 * final winner is the same model+variant — i.e. the cumulative cost pools in
 * computeTierMap actually collapsed two tiers together (post live-validation
 * fallback, which can change which model "wins" from what the raw ranking
 * picked). Purely informational.
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

/** Shared by the manual opencode_refresh_tiers tool and the automatic daily refresh below. */
async function refreshTierMap() {
  const result = await computeTierMap();
  const tiers = {};
  const verification = {};
  for (const name of TIER_NAMES) {
    const { entry, verified } = await validateTierPick(name, result.bands[name]);
    tiers[name] = entry;
    verification[name] = verified;
  }
  flagInheritedTiers(tiers);
  saveTierMap({ ...result, tiers });
  return { tiers, verification, unmatched: result.unmatched, matchedCount: result.candidates.length, computedAt: result.computedAt };
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
      const result = { subscriptionConfigured, availableModels, tiers: tierMap, tierMapMeta: getTierMapMeta() };

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
  "Force an immediate recompute of the low/mid/high/max tier map (cross-referencing opencode-go cost data against the WebDev/code arena leaderboard; each tier's pool is cumulative — everything at or under its cost ceiling, not just its own cost quartile — so a cheap model that beats pricier ones wins every tier up to its ceiling; live-probes each pick, falling through to the next-best candidate in the pool if one is unreachable). This normally happens automatically once a day the first time a job is delegated — use this tool only when you need it to happen RIGHT NOW (e.g. right after hearing the Go lineup changed), not as a routine step.",
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
  "opencode_start_job",
  "Send a job (a prompt/task) to OpenCode to work on. Pick a `tier` (low/mid/high/max) instead of a specific model name — tiers are data-driven (see opencode_refresh_tiers): each is the best-scoring model on the WebDev/code arena leaderboard within its cost band on the OpenCode Go subscription (flat-rate, no marginal cost). Default to the lowest tier that can plausibly do the job; only reach for `max` when the task clearly needs the deepest reasoning available. Runs in the background — returns a jobId immediately; poll it with opencode_job_status. Pass an explicit `model` instead of `tier` only when you specifically need something outside the tier map (see opencode_list_models). Output defaults to a clean hand-off (final result only, no narrated process) — set style:\"verbose\" only if you actually want to see the model's exploration/reasoning (e.g. debugging why a job did something unexpected).",
  {
    prompt: z.string().describe("The task/message to send to opencode"),
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
  async ({ tier, model, variant, style, ...rest }) => {
    maybeAutoRefreshTiers();
    try {
      const resolved = resolveModel({ model, tier });
      const effectiveVariant = model ? (variant ?? null) : resolved.variant;
      const prompt = style === "verbose" ? rest.prompt : rest.prompt + HANDOFF_SUFFIX;
      const jobId = startJob({ ...rest, prompt, model: resolved.model, variant: effectiveVariant });
      return ok({
        jobId,
        status: "running",
        tier: model ? null : (tier ?? DEFAULT_TIER),
        model: resolved.model,
        variant: effectiveVariant,
        style: style ?? "handoff",
        dir: rest.dir ?? null,
      });
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
