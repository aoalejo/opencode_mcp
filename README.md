# opencode-mcp

MCP server that lets Claude Code pick an [OpenCode](https://opencode.ai) model and
delegate jobs to the `opencode` CLI (which must already be installed and authenticated:
`opencode auth login`).

## Intended use case

This exists so a Claude Code session can offload work that doesn't need Claude's own
reasoning to a cheap/free model instead, without spending Claude tokens on it — code
review passes, exploratory bug hunts, well-scoped implementation from a written spec,
or any "have someone else look at this" request that doesn't name a specific Anthropic
model. It is **not** a way to run Claude itself more cheaply, and it's not meant for
tasks that genuinely need Claude-level reasoning (architecture decisions, ambiguous
requirements, anything where a wrong answer is costly) — those should stay on Claude.
The tier system (`low`/`mid`/`high`/`max`, see below) exists specifically so the caller
never has to know or care which OpenCode model is currently cheapest-yet-good-enough;
it just asks for an intelligence level and gets whatever the data says best fits it
today.

## Tools

- `opencode_check_go_status` — confirms the OpenCode Go credential is configured and lists its current model lineup. Pass `probe:true` to actually ping the mid/high/max tier models (costs a little time/tokens — don't do this routinely).
- `opencode_refresh_tiers` — recompute the low/mid/high/max tier map from live data (see "Model tiers" below). On-demand only, not routine.
- `opencode_start_job` — send a prompt/task to a `tier` (low/mid/high/max) or an explicit `model`+`variant`, in a given directory. Returns a `jobId` immediately (non-blocking).
- `opencode_job_status` — poll a job; pass `waitMs` to block until it finishes.
- `opencode_list_jobs` — list all jobs started this server session.
- `opencode_usage_stats` — aggregate tokens/cost/response-chars across *every* job this server has ever delegated (persisted, survives across sessions/processes — unlike `opencode_list_jobs`). See "Usage tracking" below.
- `opencode_cancel_job` — kill a running job.
- `opencode_list_providers` — configured credentials (e.g. OpenCode Zen, OpenCode Go, OpenRouter).
- `opencode_list_models` — list `provider/model` ids, optionally filtered by provider. Only needed when a job requires a model outside the tier map.
- `opencode_model_info` — verbose metadata (cost, context window) for one model.

Jobs shell out to `opencode run --format json`, parsing its newline-delimited JSON
event stream (`text`, `step_finish`, `error`) to assemble the final response text,
token usage, and cost as the process runs.

## Clean hand-off output, not a transcript

`jobSummary(...).text` (what `opencode_job_status`/`opencode_start_job` return) is
built only from `type: "text"` events — tool calls (file reads, bash, skill
loads), step markers, and any reasoning/thinking events are parsed but never
included. This is structural (in `src/jobs.js`'s `handleEvent`), not
prompt-dependent, so it holds regardless of `style`.

On top of that, `opencode_start_job`'s `style` param (default `"handoff"`)
appends a short instruction telling the model to skip preamble/meta-commentary
and return just the deliverable — a caller can pass `style: "verbose"` to get
the model's own narration back for debugging (e.g. "why did it read files it
didn't need to"). In testing this made a bigger difference on models prone to
chatty preambles than on `big-pickle`, which was already fairly direct — treat
it as a nudge, not a guarantee.

## Model tiers (`src/tiers.js` + `src/rank.js` + `src/leaderboard.js`)

Callers pick an intelligence tier (`low`/`mid`/`high`/`max`) instead of memorizing
model names or guessing which one is actually good. The map is **data-driven**,
built by `computeTierMap()` (`src/rank.js`):

1. Pull every `opencode-go/*` model's real per-token cost from
   `opencode models opencode-go --verbose` (local, authoritative — no scraping
   needed for this axis; the Go plan's advertised "requests per week" chart is
   just this cost data divided into a dollar budget, confirmed by cross-check).
2. Scrape `arena.ai/leaderboard/code/webdev` (`src/leaderboard.js`, plain
   server-rendered HTML table, no JS execution needed) for each model's
   WebDev/code score — matching handles the leaderboard's reasoning-effort
   suffixes (`-max`, `-high`, `-xhigh`, dated snapshots), trying an exact id
   match first so a real distinct SKU like `qwen3.8-max` isn't mistaken for
   `qwen3.8` at variant `max`.
3. Sort all matched models by cost ascending and compute a cost *ceiling* per
   tier from the quartile cutoffs (`low`'s ceiling = 25th-percentile cost,
   `mid`'s = 50th, `high`'s = 75th, `max` has none). Each tier's pool is
   **cumulative** — every candidate at or under its ceiling, not just the ones
   in its own quartile — and its winner is the single highest-arena-score
   model in that pool. This means a cheap model that outperforms everything
   pricier below its ceiling wins every tier up to that ceiling: observed
   2026-08-03, `gpt-5.6-luna` (cheap enough for `low`) outscored every model
   in the `mid` bracket and won both — there's no reason to pay more for
   something worse. Pools nest (low ⊆ mid ⊆ high ⊆ max) so scores never
   decrease going up the tiers.
4. **Live-probe** each tier's top pick with a trivial prompt before saving; if
   it's unreachable (e.g. region-locked — observed with `deepseek-v4-flash`,
   which otherwise would have won `low`+`mid`), fall through to the next-best
   candidate in the same pool instead of saving a pick that would silently
   fail every job. A tier that exhausts its whole pool without success still
   gets saved (best-effort) but flagged `verified: false`.
5. Flag a tier `inherited: true` (with `inheritedFrom: "<cheaper tier>"`) when
   its final winner is the same model+variant as a cheaper tier's — i.e. the
   collapse in step 3 actually happened, post-validation. This is informational
   only; it doesn't change any selection.
6. Persist the result to `tiers.generated.json` (gitignored — regenerate, don't
   hand-edit) so `opencode_start_job` reads it with zero extra latency/network.

**This refresh happens automatically, at most once a day, with no tool call and
no tokens spent describing it** — `opencode_start_job` (and `opencode_check_go_status`,
and server startup) check `tiers.isStale()` and fire the refresh in the
background (fire-and-forget) if the saved map is missing or >24h old. The job
that triggered the check still runs against whatever's on disk *right now*; the
refreshed map is ready for the next call. `opencode_refresh_tiers` still exists
as a manual override for "I need this recomputed right now," not for routine use.

Models the leaderboard has no entry for (e.g. `qwen3.7-plus` as of 2026-08) are
excluded from tiers but reported in `unmatched`, never silently dropped.

**Token/cost discipline:** default to `low` unless the task clearly needs more
reasoning depth — `mid`/`high`/`max` don't cost extra dollars under a Go
subscription, but every job still burns real tokens and wall-clock time. An
explicit `model` (+ optional `variant`) param on `opencode_start_job` overrides
the tier for one-off cases outside the map.

## Notable free/no-extra-cost models seen on this machine

- `opencode/big-pickle` — free on OpenCode Zen (cost: 0).
- `opencode-go/*` — included in the OpenCode Go subscription. Some entries can be
  slow, region-restricted, or hang depending on OpenCode's backend that day —
  `opencode_cancel_job` exists for exactly that.

## Usage tracking (`src/usage.js`)

Every job, on completion (success or failure), appends one line to
`~/.local/share/opencode-mcp/usage-log.jsonl` — outside the repo, machine-local,
grows forever, same convention as opencode's own `~/.local/share/opencode`. Each
record has tokens, list-price cost, prompt/response character counts, tier, model,
and duration. `opencode_usage_stats` reads it back and aggregates totals + a
per-model breakdown; pass `sinceHours` to scope to recent activity only.

`cost` is OpenCode's own list price for the tokens used — under the Go subscription
(flat-rate) or Zen (free tier) the dollars actually charged is $0 regardless, so the
aggregated total **is** the savings from delegating instead of paying per-token. It
is **not** a comparison to Claude/Anthropic API pricing — there's no reliable way to
know what equivalent work would have cost in a different model's tokenizer, so this
tool doesn't claim to measure that.

This log is separate from (and complements) OpenCode's own `opencode stats
--models`, which aggregates *all* opencode usage on the machine regardless of what
started it — use that for the full-machine picture, use `opencode_usage_stats` to
scope specifically to what this MCP server delegated.

## Install

```bash
npm install
```

## Register with Claude Code

```bash
claude mcp add opencode --scope user -- node /Users/alejoarueocampo/Developer/opencode-mcp/src/index.js
```

Takes effect in new Claude Code sessions (an already-running session won't pick up
newly registered servers).

## Safety note

`opencode_start_job` accepts an `auto` flag that maps to opencode's `--auto`
(auto-approve all tool permissions). It's off by default; only set it for jobs you
trust to edit files / run commands unattended.
