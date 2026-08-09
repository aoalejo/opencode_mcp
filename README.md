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

- `opencode_check_go_status` — confirms the OpenCode Go credential is configured, lists its current model lineup, and reports currently-blocked models. Pass `probe:true` to also manually ping the mid/high/max tier models right now (costs a little time/tokens — this is a diagnostic option, not part of the automatic failure-handling below).
- `opencode_refresh_tiers` — recompute the low/mid/high/max tier map from live data (see "Model tiers" below). Pure local computation, effectively free. On-demand only, not routine (it already runs automatically once a day).
- `opencode_unblock_model` — manually clear a model from the failure blocklist (exponential backoff, not a flat block — see "Automatic failure handling" below) and recompute immediately, e.g. right after re-enabling it in the OpenCode dashboard.
- `opencode_start_job` — send a prompt/task to a `tier` (low/mid/high/max) or an explicit `model`+`variant`, in a given directory. Pass `waitMs` to block until it finishes and get the full result back in this same call (recommended — see "No push notifications" below); omit it for fire-and-forget (returns just a `jobId`).
- `opencode_job_status` — check on a job started earlier; pass `waitMs` to block until it finishes.
- `opencode_list_jobs` — list all jobs started this server session.
- `opencode_usage_stats` — aggregate tokens/cost/response-chars across *every* job this server has ever delegated (persisted, survives across sessions/processes — unlike `opencode_list_jobs`). See "Usage tracking" below.
- `opencode_cancel_job` — kill a running job.
- `opencode_list_providers` — configured credentials (e.g. OpenCode Zen, OpenCode Go, OpenRouter).
- `opencode_list_models` — list `provider/model` ids, optionally filtered by provider. Only needed when a job requires a model outside the tier map.
- `opencode_model_info` — verbose metadata (cost, context window) for one model.

Jobs shell out to `opencode run --format json`, parsing its newline-delimited JSON
event stream (`text`, `step_finish`, `error`) to assemble the final response text,
token usage, and cost as the process runs.

## Completion detection uses `exit`, not just `close` (`src/jobs.js`)

Node's `close` event on a spawned child only fires once ALL of its stdio file
descriptors are closed — if `opencode run` leaves a descendant process running
(a backgrounded bash command, another MCP server it connected to, an orphaned
watcher) that inherited those pipes, `close` can be delayed by seconds,
minutes, or indefinitely, even though `opencode`'s own process — and the real
work it did (files written, answer produced) — finished long ago. Observed
2026-08-09: a multi-agent orchestration session had jobs whose actual output
files were already written, but `opencode_job_status` kept reporting them as
still running, forcing a workaround of reading the files directly instead of
trusting the job status. Reproduced in isolation: a child that backgrounds a
`sleep` and exits fires `exit` at ~15ms but `close` at ~5000ms — a 5-second
gap from one lingering subprocess, with no ceiling on how long a real one
could hold it.

Fixed by listening to both `exit` and `close`, settling the job on whichever
fires first (`exit` will normally win when this scenario occurs; a `settled`
guard prevents double-finalizing on the completely normal case where both
fire within milliseconds of each other). When the second event does arrive
much later, its gap is logged to stderr — real production evidence of how
often/how badly this happens, not just a synthetic test's word for it.

## No push notifications — jobs don't "ping back" when done

MCP tool calls are strictly request/response: this server has no way to interrupt
a Claude Code conversation on its own when a background job finishes. This is
*not* like Claude Code's native `run_in_background: true` for Bash/Agent, where
the harness itself pushes a notification the instant the task completes — that
mechanism is specific to the harness's own process tracking and doesn't extend to
arbitrary MCP servers. `jobs.js`'s internal `EventEmitter` ("done") only resolves
a call that's *actively* `await`-ing it (`waitForJob`); it can't reach into a
conversation that already moved on.

Two ways to actually get a result, neither of which involves waiting for a ping
that will never arrive:

- **Block on `waitMs`** (recommended for most jobs): pass `waitMs` to
  `opencode_start_job` (or a follow-up `opencode_job_status`) — up to 540000ms
  (9 min) — and the call itself won't return until the job finishes, with the
  full result (text, tokens, cost) in the same response.
- **Fire-and-forget + manual follow-up**: omit `waitMs` to get just a `jobId`
  back immediately, do other work, then call `opencode_job_status({ jobId })`
  yourself later. There is no notification to wait for — if you don't check
  back, the result just sits there until you do (or the server process exits).

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
   in its own quartile.
4. Within a tier's pool, the winner is **not simply the highest score** — it's
   the cheapest model within `SCORE_TOLERANCE_PCT` (1%, `rank.js`) of the
   pool's best score. A 1676-vs-1668 gap (0.5%) doesn't justify paying 50%
   more, so the cheaper one wins; a 1577-vs-1523 gap (3.5%) is treated as a
   real quality difference and the higher scorer still wins outright. This
   also means a cheap model that's merely "good enough" relative to a tier's
   ceiling can win it without being the pool's outright top scorer — e.g.
   observed 2026-08-05, `qwen3.8-max` ($2, score 1668) beat `kimi-k3` ($3,
   score 1676) for `max` under this rule. Pools nest (low ⊆ mid ⊆ high ⊆ max)
   so scores are still monotonically non-decreasing from low to max.
5. Flag a tier `inherited: true` (with `inheritedFrom: "<cheaper tier>"`) when
   its final winner is the same model+variant as a cheaper tier's — i.e. one
   model was good/cheap enough to win multiple tiers. Informational only.
6. Persist the result (including each tier's full fallback list, not just the
   winner) to `tiers.generated.json` (gitignored — regenerate, don't hand-edit).

This is a **pure local computation** — one `opencode models --verbose` call
plus one HTTP fetch of the arena leaderboard, no `opencode run` calls at all.
See "Automatic failure handling" below for how broken models get excluded
without needing to proactively probe every one of them.

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

## Automatic failure handling — no proactive probing (`recordJobOutcome` in `index.js`)

Earlier versions of this ranker live-probed every tier's pick with a trivial
prompt before saving, to catch models that score well but are actually
unreachable (region-locked, disabled in the OpenCode dashboard, etc). That
cost real tokens/time on every refresh — small per probe, but recurring, and
it got a false positive: a legitimately slow reasoning model (`kimi-k3/max`,
30-60s for even a 1-word answer) got treated as "broken" by a too-short probe
timeout. Both problems are solved by not probing at all:

- Every `opencode_start_job` tier resolution is tried for real. If it fails
  with a genuine error (non-zero exit / an error message — e.g. `deepseek-v4-flash`
  returning "requires explicit opt-in" when disabled in the dashboard), that
  model+variant is **blocked with exponential backoff** and the tier map is
  recomputed immediately to exclude it — this happens whether or not the
  caller passed `waitMs`, so even fire-and-forget jobs self-heal the map for
  next time.
- **"Still running" past a timeout is never treated as a failure** — only an
  actual error is. This is the fix for the `kimi-k3/max` false positive: a
  slow-but-working model is never penalized just for being slow.
- If `waitMs` was passed, a hard failure is retried automatically (up to 5
  attempts) with the next-best candidate in the same cost pool, within the
  *same* `opencode_start_job` call — the caller gets a working result without
  needing to notice the failure and retry manually.
- **Backoff, not a flat block** (`BACKOFF_SCHEDULE_MS`, `tiers.js`): 5min for a
  first failure, escalating to 30min → 2h → 8h → 24h only if the model keeps
  failing on repeated real attempts. A single success clears the failure
  history entirely, so the next isolated blip starts back at 5min instead of
  compounding. This exists because a flat 24h block (the original design)
  meant a brief real outage — observed 2026-08-08, `deepseek-v4-flash` down for
  what was probably minutes — kept routing to a pricier fallback (`gpt-5.6-luna`)
  for the rest of the day until manually unblocked, visibly spiking that day's
  spend for no good reason. To force a block clear sooner regardless of backoff
  — e.g. right after re-enabling a model you'd disabled in the OpenCode
  dashboard — call `opencode_unblock_model`. Current blocks (with remaining
  backoff time) are visible in `opencode_check_go_status`'s `blocked` field.
- Cost is paid **only on real usage, only when something's actually broken**
  — not on a schedule, not "just in case." A model that's simply never used
  is never checked and never costs anything.

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
claude mcp add opencode --scope user -- node /path/to/opencode-mcp/src/index.js
```

Replace `/path/to/opencode-mcp` with wherever you cloned this repo (e.g. run
`pwd` from inside it to get the absolute path).

Takes effect in new Claude Code sessions (an already-running session won't pick up
newly registered servers).

## Safety note

`opencode_start_job` accepts an `auto` flag that maps to opencode's `--auto`
(auto-approve all tool permissions). It's off by default; only set it for jobs you
trust to edit files / run commands unattended.
