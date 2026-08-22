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
- `opencode_job_status` — check on a job started earlier (works across a server restart or a different process — see "Job state survives a restart" below); pass `waitMs` to block until it finishes.
- `opencode_resume_job` — nudge an existing opencode session to continue instead of starting over, e.g. after a transient hiccup derailed it. See "Resuming a derailed job" below.
- `opencode_list_jobs` — list all jobs started this server session (in-memory only, unlike the two above).
- `opencode_usage_stats` — aggregate tokens/cost/response-chars across *every* job this server has ever delegated (persisted, survives across sessions/processes — unlike `opencode_list_jobs`). See "Usage tracking" below.
- `opencode_cancel_job` — kill a running job.
- `opencode_list_providers` — configured credentials (e.g. OpenCode Zen, OpenCode Go, OpenRouter).
- `opencode_list_models` — list `provider/model` ids, optionally filtered by provider. Only needed when a job requires a model outside the tier map.
- `opencode_model_info` — verbose metadata (cost, context window) for one model.
- `opencode_audit` — fan N forced-read-only reviewers out over uncommitted changes (or a commit range), confidence-ranked and adversarially re-checked. See "Multi-agent orchestration" below.
- `opencode_sweep` — audit an ENTIRE codebase in path-coherent segments, feeding confirmed findings forward so later segments hunt new instances instead of re-reporting known ones. Long-running: returns a `sweepId`, poll it.
- `opencode_sweep_status` — progress, the confirmed-findings ledger, and the path to the markdown report (rewritten after every segment).
- `opencode_investigate` — same read-only fan-out/reconcile shape as `opencode_audit`, but for an arbitrary question instead of a diff.
- `opencode_goal` — sequential passes toward a goal, with real lint/test output fed to each next pass, verified read-only at the end.
- `opencode_job` — runs `opencode_goal` then `opencode_audit` on whatever it produced, and hands both results back untouched.

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

## Job state survives a restart (`src/job-store.js`)

In-memory-only job tracking means the instant this MCP server process
restarts or crashes — or a DIFFERENT process (another Claude Code session)
tries to look up a job it didn't start — `opencode_job_status` returns `No
job with id "..."`, even though the real opencode session and everything it
produced (files written, answer given) are completely intact. Observed
2026-08-09 right after this exact scenario.

Every job's state (model, variant, dir, sessionId, tokens, cost, and the
assembled response text) is checkpointed to disk at
`~/.local/share/opencode-mcp/jobs/<jobId>.json` on every `step_finish` event
and on final completion/failure — frequent enough that a killed process still
leaves recent progress recoverable, not so frequent it's meaningful I/O
overhead. `getJob`/`opencode_job_status`/`opencode_resume_job` all fall back
to this file when a job isn't in the current process's memory. `opencode_list_jobs`
does NOT include disk-only jobs (it only enumerates what THIS process
remembers) — it's for browsing the current session's own work, not a full
history; look a specific job up by id instead if you know it.

## Resuming a derailed job (`opencode_resume_job`)

Sometimes a job goes in circles, loses context, or a transient hiccup (a
network blip, a tool call that failed weirdly) visibly derails it without an
outright process failure — the kind of thing you'd fix by hand in the
opencode TUI by finding the session and typing "hubo un error de red,
continuá desde donde quedaste." `opencode_resume_job` does exactly that
programmatically: it starts a new job continuing the SAME opencode session
(via `--session <id>`, not `--continue`, so it targets a specific session
rather than "whatever was last") with a nudge prompt (a sensible default, or
your own if you know what actually went wrong).

Pass `jobId` (works across a restart/different process, per the above) or
`sessionId` directly. Verified end-to-end, including across a simulated
server restart: a fresh process with zero shared memory recovered a job's
`sessionId` from disk, resumed it, and the model correctly recalled context
from before the "restart."

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

## Pinning one model for a whole session (`OPENCODE_MCP_PIN_MODEL`)

Every `opencode-mcp` server process is tied 1:1 to the Claude Code session
that spawned it, and an env var is fixed for that process's whole lifetime —
so setting `OPENCODE_MCP_PIN_MODEL` (and optionally `OPENCODE_MCP_PIN_VARIANT`)
when registering the server forces literally every `opencode_start_job` call
in that session to one fixed model, bypassing cost/score ranking and the
failure blocklist entirely:

```bash
claude mcp add opencode --scope user \
  --env OPENCODE_MCP_PIN_MODEL=opencode-go/deepseek-v4-flash \
  --env OPENCODE_MCP_PIN_VARIANT=high \
  -- node /path/to/opencode-mcp/src/index.js
```

**The pin is a HARD override — it wins even over an explicit `model` param.**
That's deliberate: the whole point is "this session always uses X, no
exceptions," including the exact case a pin exists for — you forget it's
pinned and ask for something else by name (`model: "opencode-go/kimi-k3"`) or
via `tier`. When the actual request differs from the pin, the response
carries a `warning` field spelling out what was asked for vs what got forced,
so the override is never silent — no `warning` field means nothing was
overridden (including the normal case of a plain `tier` call, which a pin
always "overrides" by design and doesn't warn about).

Useful when you want predictable, consistent model usage for a session
regardless of day-to-day ranking drift or in-flight failures. Whether a pin
is active (and what it's pinned to) is visible in `opencode_check_go_status`'s
`pinnedModel` field. Note this only affects the *session that registers it
this way* — concurrent sessions each run their own server process with their
own env, so this isn't a machine-wide setting.

## Matching the concurrency ceiling to your backend (`OPENCODE_MCP_MAX_CONCURRENCY`)

`opencode_audit`/`opencode_investigate`/`opencode_sweep` fan participants out
through a rolling-window concurrency limiter, not fixed batches — as soon as
any one job finishes, the next queued one starts immediately, rather than
waiting for a whole wave to complete before starting the next. The ceiling on
how many run at once defaults to a conservative `4`, since this server has no
way to know what your actual model backend can serve. If yours can genuinely
handle more — e.g. a local multi-agent-capable server advertising a real
concurrency limit of 16 — set that once at registration instead of passing
`maxConcurrency` on every call:

```bash
claude mcp add opencode --scope user \
  --env OPENCODE_MCP_MAX_CONCURRENCY=16 \
  -- node /path/to/opencode-mcp/src/index.js
```

The full chain is: **`maxConcurrency` passed on that specific call** → **the
env var** → **4**. Nothing in it is cached at server startup — the env var is
read fresh on every single dispatch, not baked into a frozen default the
moment this process boots. That mostly matters for the ordinary case: pass
`maxConcurrency` directly on any call whenever you want to change the ceiling
right now, no server restart needed either way. The effective fallback is
visible in `opencode_check_go_status`'s `defaultMaxConcurrency` field.
Getting this wrong in either direction has a real cost: too low and you leave
real backend capacity idle for no reason; too high and you get exactly the
failure mode this setting exists to prevent — observed 2026-08-22, a sweep at
`replicas:4` (48 concurrent participants) against a backend that couldn't
actually serve that many ran 5h42m without a single segment completing.

## Multi-agent orchestration: audit / investigate / goal / job (`src/orchestrate.js`)

One model call is one opinion. These four tools spend extra parallel calls —
close to free when `OPENCODE_MCP_PIN_MODEL` points at a local model, since
sending 1 request or 16 costs the same wall-clock time and money — to get a
more reliable answer than a single pass would: many independent read-only
reviewers instead of one, confidence-ranked instead of blindly trusted,
adversarially re-checked instead of taken at face value. `defaultWidth()`
detects whether the resolved model is actually the free local one (or a paid
tier) and scales default participant counts up or down accordingly, so a
paid-tier call doesn't silently balloon in cost just because the code assumes
parallelism is free.

### One-time setup: the `mcp-readonly` opencode agent

Every read-only reviewer/aggregator/verifier across all four tools runs as a
dedicated opencode agent, **`mcp-readonly`**, registered once in
`~/.config/opencode/opencode.jsonc` (a machine-level config file, NOT part of
this repo — each machine running this MCP server needs this added once):

```jsonc
{
  "agent": {
    "mcp-readonly": {
      "mode": "primary",
      "description": "Forced read-only agent used by opencode-mcp's audit/investigate/goal-verify commands — cannot edit files, run shell commands, or invoke skills/sub-tasks.",
      "permission": {
        "read": "allow",
        "grep": "allow",
        "glob": "allow",
        "list": "allow",
        "webfetch": "allow",
        "websearch": "allow",
        "edit": "deny",
        "bash": "deny",
        "task": "deny",
        "skill": "deny",
        "todowrite": "deny"
      }
    }
  }
}
```

**`mode` must be `"primary"`, not `"subagent"`.** `opencode run --agent
<name>` silently falls back to the default agent (defeating the whole
read-only guarantee, with only a stderr warning to notice it) if the named
agent isn't a primary one — found this the hard way while testing.
Verify it registered with `opencode agent list` — it should show
`mcp-readonly (primary)`.

### QA lenses (`src/lenses.js`)

Reviewers don't get a vague theme ("look for correctness bugs"), they get one
narrow, mechanically checkable instruction. That distinction matters more than
it sounds: asked for "correctness bugs", a weak local model returns a wall of
plausible prose restating the diff; asked to *"check the EXACT operator against
what the comment says the boundary should be, and trace what happens when the
value is exactly at the boundary"*, it does real work. Narrow lenses also make
N parallel reviewers genuinely diverge instead of producing N near-duplicates.

Six core lenses run by default:

| key | hunts for |
| --- | --- |
| `sign_direction` | gain/loss, credit/debit, from/to swapped or inverted against the documented convention |
| `boundary_offbyone` | `<` vs `<=`, exactly-at-the-boundary cases, loop/slice/pagination arithmetic, inclusive vs exclusive ranges |
| `mutation_ordering` | index-based removal inside a loop, mutation during iteration, symmetric paths handled inconsistently |
| `priority_ordering` | "best match" loops that are actually greedy/local, tie-breaks that silently pick wrong, shadowed rule chains |
| `security` | auth bypass, missing ownership/permission checks, injection, credential leakage, unsafe defaults |
| `performance` | N+1 access, unbounded work, blocking the hot path, repeated recomputation, never-invalidated caches |

Six more are available via `lenses: "all"` or an explicit subset:
`null_empty`, `error_handling`, `concurrency`, `contract_mismatch`,
`state_consistency`, `test_gaps`.

Every lens ends with the same reporting contract — file, location, what the
code does vs should do, a **concrete failing scenario** (specific inputs →
specific wrong output), and a severity — plus an explicit `NO FINDINGS`
sentinel so "found nothing" is distinguishable from "rambled inconclusively".

**Replicas, not a flat count.** `replicas` (default 2, hard minimum 2) gives
*every* selected lens that many independent reviewers. This replaced spreading
a flat participant count round-robin, where some lenses drew 3 reviewers and
others 2 — so "2+ participants agreeing = CONFIRMED" silently meant different
things depending on which lens you got. With uniform replicas, corroboration is
measured against a known denominator. Total participants = lenses × replicas,
clamped to `MAX_PARTICIPANTS`. The legacy `count` param still round-robins if
you'd rather cap total spend than get even coverage.

**Project context.** Every reviewer's prompt is prefixed with a domain/
architecture file — `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or
`README.md`, auto-detected, or set explicitly via `contextFile`. A reviewer
that doesn't know "distributions count as an expense in this ledger" reports
confident nonsense; a paragraph of domain context removes a whole category of
false positives.

### `opencode_audit` and `opencode_investigate`

Both fan N participants out **in parallel**, all forced onto `mcp-readonly`
(a real permission-engine guarantee, not a prompt asking nicely), then run
them through the same confidence-ranked reconciliation:

1. **Round 0**: N participants' independent findings are reconciled into ONE
   report that explicitly notes how many participants corroborated each
   finding — 2+ is CONFIRMED, exactly 1 is LOW CONFIDENCE.
2. **Adversarial round(s)** (`depth` times, default 1): a FRESH batch of N
   reviewers gets ONLY the current report, framed as "a low-confidence agent
   reported this, your job is to determine its falseness" — each
   independently tries to refute the low-confidence items using its own
   read-only access to the real code. The results are reconciled into
   [previous report + all adversarial reviews], promoting survivors to
   "adversarially confirmed" and calling out (never silently dropping)
   anything refuted. `depth=0` skips this; `depth=2` repeats the whole
   round-then-reaggregate step twice for higher-stakes reviews.

`opencode_audit` reviews a git diff — uncommitted changes by default, or
everything since `baseCommit` (a whole branch/PR) when given. If the diff is
too large (~100k+ tokens) to hand every participant, every reviewer gets the
same bounded prefix plus the paths left out (they have read access and can
open those themselves) — see "QA lenses" above for how reviewers are actually
assigned and diversified; this replaced an older per-file partitioning scheme
that broke once `replicas` meant reviewers sharing a lens must see identical
content for their agreement to mean anything.

### Hierarchical aggregation (tree reduction, `groupSize`)

"ONE aggregator" above is a simplification for small N. Both reconciliation
steps (round 0, and each adversarial reaggregation) actually run through a
**tree** of aggregator calls, each combining at most `groupSize` sources
(default 4) — not one aggregator reading every participant's output at once.

This exists because a flat aggregator's prompt scales with participant count
× however verbose each one felt like being. Observed 2026-08-22: 12 lenses ×
2 replicas (24 participants, ~7k chars each) produced a **162,000-character**
aggregator prompt that outran a 5-minute wait entirely — the local model
never got through it, and the whole review silently came back as an empty
report. Two fixes landed together:

- A hard per-source cap (6,000 chars) on what reaches any single aggregator
  call — a participant that rambles past this is truncated, not allowed to
  starve the rest.
- The tree reduction itself: leaf-level groups of `groupSize` participants
  each get reconciled into a partial report IN PARALLEL (they're independent
  — this also cuts wall-clock time, not just risk), then those partial
  reports are merged in the same way, recursively, until one report remains.
  Merge-level prompts are told explicitly to **add up** corroboration counts
  across partials rather than trust each partial's count as final — a
  finding at 2-of-4 in one partial and 1-of-4 in another is 3-of-8 combined,
  which is CONFIRMED overall even though neither partial alone reached 2.

Lower `groupSize` if aggregation still times out or comes back empty at a
high `replicas`/lens count; raise it to trade fewer, larger aggregator calls
for less merge overhead. This also means `opencode_sweep`'s per-segment
reconciliation scales with lens/replica count more gracefully than a flat
aggregator ever could.

`opencode_investigate` is the same shape driven by an arbitrary `prompt`
instead of a diff — use it to have several independent agents look into one
question and get back a reconciled answer, e.g. "does the test suite
actually cover the new drill-down interaction, or just that it renders?"

### `opencode_goal`

**Sequential, not parallel** — these agents actually edit code, and running
them concurrently in the same working tree would corrupt each other's
changes. (An earlier version ran independent parallel attempts judged by a
panel — reverted after real testing showed the judge panel, being the same
weak model, reject genuinely correct candidates outright; see the git
history around `runGoal` if curious.) Pass 1 attempts the goal fresh; each
later pass continues the *previous* pass's own opencode session.

The actual defense against a weak model trusting its own "done!" self-report:
after **every** pass, real `lint`/`test` commands run against `dir` — a
mechanical, ground-truth signal, not another LLM's opinion — and the genuine
pass/fail output gets attached to the *next* pass's prompt. Commands
auto-detect from `dir`'s `package.json` (`scripts.lint`/`scripts.test`) if
not given explicitly; pass `lintCommand`/`testCommand` to override, or
explicit `null` to force-disable one. Once every pass finishes, one final
`mcp-readonly` pass inspects the repo's actual current state (not the
passes' self-reports) and returns a consolidated verification report.

### `opencode_job`

Runs `opencode_goal` to completion, then immediately runs `opencode_audit` on
whatever it left uncommitted, and returns **both results verbatim** — it
does not interpret the QA findings, decide they're serious, or trigger
another goal pass on its own. Deciding what to do with what QA found (fix it,
ignore it, ask the user) is explicitly the caller's job, not this tool's —
matches this whole project's stance of surfacing information rather than
silently resolving it on the caller's behalf.

### `opencode_sweep` — auditing a whole codebase

`opencode_audit` reviews a diff. `opencode_sweep` reviews an entire repository,
which needs three things a diff review doesn't.

**Segmentation.** The repo is split into token-budgeted segments (default ~40k
tokens), packed **by path rather than by size** so a directory stays together.
That's deliberate: bin-packing by size would scatter related files across
segments and destroy exactly the findings that span them — a caller and callee
disagreeing about a contract, two symmetric paths where only one was updated.
A single file over budget gets its own segment rather than being cut
mid-function.

**A segment is a starting point, not a cage.** Reviewers get their sector's
contents inlined, and are explicitly told to follow a flow into any other file
in the repo when tracing it end-to-end is what the lens requires — they have
read access to everything. Findings outside the assigned sector are reported
and flagged as such.

**A findings ledger that feeds forward.** After each segment, the reconciled
report emits a compact machine-readable block that's parsed in plain JS into a
running ledger. Every *later* segment gets that ledger with the instruction:
don't re-report these, but do look for **other instances of the same bug
class** — a confirmed pattern usually repeats. Refuted findings carry forward
too, so a false positive dismissed in segment 3 isn't re-litigated in segment
12. The ledger is capped at the most recent ~40 entries so it can't crowd out
the prompt on a long run.

**Always dry-run first.** `plan: true` spawns nothing and returns the file
list, segment breakdown, and a job estimate:

```
opencode_sweep({ dir: "/path/to/repo", plan: true, lenses: "all", replicas: 4 })
```

Check `fileCount`, `segmentCount`, `estimatedJobs`, and the `skipped` counts
before committing to a run — the estimate is how you find out a sweep would
take six hours *before* it takes six hours.

**Then trial one segment before committing to all of them.** Pass
`maxSegments: 1` with the exact same `lenses`/`replicas`/`maxConcurrency`
you're about to run for real — this exercises the complete pipeline (full
lens fan-out, tree-reduction aggregation, the adversarial round, ledger
emission) at real scale, in a fraction of the wall-clock time. It's how you
find out your `maxConcurrency` is wrong for this backend, or that a lens is
producing garbage, before spending hours discovering it one segment at a
time. Once a single segment behaves the way you expect, drop `maxSegments`
and run the whole thing.

**File selection is language-agnostic and yours to override.** Defaults exclude
vendor/build dirs, lockfiles, minified bundles, and generated-code patterns
(`*.g.*`, `*.pb.*`, `*.generated.*`, `*.freezed.*`); files are additionally
sniffed for `@generated` / "DO NOT EDIT" headers, which catches generated code
in any language that globs would miss. Override with `sourceExtensions`,
`includeGlobs`, and `excludeGlobs`.

**It runs in the background.** A real sweep runs for an hour or more — far past
any MCP client's request timeout — so `opencode_sweep` returns a `sweepId`
immediately and `opencode_sweep_status` polls it. Full state is checkpointed to
`~/.local/share/opencode-mcp/sweeps/<id>.json` and the markdown report at
`<id>.md` is **rewritten after every segment**, so partial results are readable
while it runs and survive the process dying. Segments run strictly sequentially
— parallelising them would break the ledger's whole purpose.

**Polling shows real progress, not just "running."** The active segment's
`phase` field updates live at every meaningful transition — participant N/M
finished, aggregator-tree level 1 group 3/6 done, entering the adversarial
round — not just at segment start/end. A segment sitting at `status: running`
for 40 minutes with `phase` visibly advancing is a healthy sweep; one where
`phase` hasn't changed across several polls is worth investigating (check
whether the model backend itself is actually responding — a network-level
hang looks identical to genuine work from the outside if you're not watching
this field).

**Cancel it if it's not going well.** `opencode_sweep_cancel` stops a running
sweep — before it existed the only way was killing the whole MCP server
process, taking every other tool down with it for the rest of the session. It
checks cooperatively (between segments, and inside the current segment's
concurrency-limited dispatch), so it typically responds within one wave —
bounded by `maxConcurrency` — rather than only at the next segment boundary.
It's an in-process signal, same constraint as `opencode_cancel_job`: it can
only stop a sweep that the server process handling this call is itself
running.

### Briefing another agent to run a sweep

A prompt you can hand to another Claude Code session, verbatim, to have it
sweep an unfamiliar project. It deliberately makes the agent choose the file
filters itself rather than prescribing them — only the agent looking at the
repo knows what's generated, vendored, or irrelevant in it.

> You have an MCP server called `opencode` that can run a whole-codebase QA
> audit using a swarm of read-only agents. Use it on this repository.
>
> **Step 1 — decide what to review.** Look at the repo layout first (top-level
> dirs, the manifest/build file, any `.gitignore`). Then work out which files
> are actually worth reviewing: application source, not generated code, not
> vendored dependencies, not build output, not fixtures/snapshots, not
> committed assets. Whatever this project's stack generates or vendors, exclude
> it.
>
> **Step 2 — dry run.** Call `opencode_sweep` with `plan: true`, `lenses:
> "all"`, `replicas: 4`, and your chosen `sourceExtensions` / `includeGlobs` /
> `excludeGlobs`. It spawns nothing and returns the file list, the segment
> breakdown, and a job estimate. Read the `skipped` counts and the segment
> list: if something important was excluded, or something generated slipped
> through, fix the filters and re-plan. Do not skip this step.
>
> **Step 3 — confirm scale, then trial exactly one segment.** Report the plan
> back to me — file count, segment count, estimated jobs — and say roughly how
> long the full run would take. Then call `opencode_sweep` again WITHOUT
> `plan` but WITH `maxSegments: 1` and the exact same `lenses`/`replicas` you
> intend to use for real. This exercises the complete pipeline (fan-out, tree
> aggregation, the adversarial round, ledger emission) at real scale in a
> fraction of the time — it's how you catch a wrong `maxConcurrency`, a
> misbehaving lens, or a backend that can't actually keep up, before finding
> out three segments into a six-hour run. Poll `opencode_sweep_status` while
> it runs (see below) and confirm the trial segment reaches `completed`, not
> `incomplete` or `failed`, before proceeding.
>
> **Step 4 — tune `maxConcurrency` if the trial showed trouble.** If the trial
> segment came back `incomplete` (reconciliation never finished) or included
> "Unexpected server error" responses, the model backend couldn't keep up with
> the request volume — lower `maxConcurrency` (default 4) and re-trial rather
> than raising `waitMs`, which doesn't address the actual cause. If it
> finished cleanly and you know the backend can genuinely serve more
> concurrent requests, you can raise `maxConcurrency` instead of leaving
> capacity idle.
>
> **Step 5 — run it for real.** Call `opencode_sweep` again without `plan` or
> `maxSegments`, same `lenses`/`replicas`/`maxConcurrency` that worked in the
> trial. It returns a `sweepId` immediately and runs in the background; there
> is NO notification when it finishes. Poll `opencode_sweep_status` with that
> `sweepId` periodically — the active segment's `phase` field updates live
> (e.g. "Reviewing: 30/48 participant(s) finished"), so you can tell real
> progress from a stall without waiting for a segment to complete. The
> `reportPath` it returns points at a markdown report rewritten after every
> segment, so it's readable while the sweep is still going. If something looks
> wrong mid-run, `opencode_sweep_cancel` stops it — you don't have to let a bad
> run finish just because it started.
>
> **Step 6 — report back.** When `status` is `completed`, read the report file
> and summarise: the confirmed findings grouped by severity, which are worth
> acting on now, and which look like false positives to you. Do NOT fix
> anything yet — verify each high-severity finding against the real code
> yourself first and tell me which ones you actually believe, because a
> swarm of small models produces some confident nonsense and the point of your
> pass is to catch it.
>
> Notes: `replicas: 4` means every one of the 12 lenses gets 4 independent
> reviewers per segment — that's the redundancy that makes the confidence
> ranking meaningful, and it's why the job estimate is large. `depth: 1` (the
> default) adds one adversarial round per segment that tries to refute
> single-source findings.

### Try it yourself

```bash
mkdir -p /tmp/opencode-mcp-demo && cd /tmp/opencode-mcp-demo
git init -q && git config user.email "demo@demo.com" && git config user.name "Demo"

cat > calc.js << 'EOF'
function multiply(a, b) {
  return a * b;
}
module.exports = { multiply };
EOF

cat > calc.test.js << 'EOF'
const assert = require("assert");
const { multiply, divide } = require("./calc");
assert.strictEqual(multiply(2, 3), 6);
assert.strictEqual(divide(10, 2), 5);
console.log("all tests passed");
EOF

cat > package.json << 'EOF'
{
  "name": "opencode-mcp-demo",
  "scripts": {
    "test": "node calc.test.js",
    "lint": "node -e \"require('./calc.js'); console.log('lint ok')\""
  }
}
EOF

git add -A && git commit -q -m "initial"
```

Then, from Claude Code (with this MCP server registered — see "Register with
Claude Code" below), ask something like:

> Use opencode_job on /tmp/opencode-mcp-demo with the goal "the test suite in
> calc.test.js is failing — fix calc.js so `npm test` and `npm run lint` both
> pass," then tell me what happened.

Expected: pass 1 adds the missing `divide` function, the lint/test checks
that run right after come back green, and the QA audit that follows finds
nothing wrong with the (correct, minimal) diff. To see the reconciliation
mechanism do real work instead of rubber-stamping, try `opencode_audit`
directly on a deliberately messier diff — introduce an actual bug (e.g. an
inverted comparison or a copy-pasted line) before auditing, and check that it
shows up as CONFIRMED (if more than one lens/reviewer flags it) rather than
buried in a wall of text.

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
newly registered servers). This also means **different concurrent sessions can be
running different versions of this server's code** — a session started before a
fix landed keeps running its old behavior until it's restarted. If you see
inconsistent model choices across sessions on the same day, this is the first
thing to check, not necessarily a ranking bug.

## Safety note

`opencode_start_job` accepts an `auto` flag that maps to opencode's `--auto`
(auto-approve all tool permissions). It's off by default; only set it for jobs you
trust to edit files / run commands unattended.
