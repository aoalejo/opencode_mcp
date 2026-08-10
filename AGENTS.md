# Agent instructions for opencode-mcp

This is an MCP server that delegates work to the `opencode` CLI. If you're a
coding agent (Claude Code or otherwise) with these tools connected, follow this:

## Optimize for tokens, not just correctness

- Default to the `low` tier on `opencode_start_job`. Only step up to `mid`/
  `high`/`max` when the task clearly needs deeper reasoning (e.g. reviewing
  non-trivial logic, multi-file architecture questions) — not by default "to
  be safe."
- Don't pick a `model` by name unless you have a real reason to go outside the
  tier map. Naming models defeats the point of the tier abstraction and tends
  to drift toward "just use the biggest one."
- Prefer one well-scoped prompt over several small back-and-forth jobs when
  you can — each `opencode_start_job` call spins up a fresh process and
  session.
- Use `opencode_check_go_status` (without `probe:true`) to see what's
  configured; only pass `probe:true` when you're about to depend on a
  specific tier working and need to confirm it live. Don't probe routinely —
  it costs real tokens on the OpenCode Go side even though it's flat-rate to
  you.
- Don't call `opencode_refresh_tiers` routinely — the tier map already
  auto-refreshes at most once a day on its own (see below), with zero tool
  calls and zero tokens. Only call it when you specifically need the ranking
  recomputed right now.

## Jobs never "ping back" — you will not be notified when one finishes

There is no push channel from this server to your conversation. Do not call
`opencode_start_job` without `waitMs`, then move on assuming you'll be told when
it's done — you won't be, ever, by any mechanism. This is unlike native
`run_in_background: true` Bash/Agent tasks, which the harness itself tracks and
notifies you about; that's a harness-specific feature, not something arbitrary
MCP servers get. Two correct patterns:

- Default to passing `waitMs` (up to 540000/9min) on `opencode_start_job` so the
  call blocks and returns the full result directly — this is right for most jobs.
- Only omit `waitMs` when you deliberately want fire-and-forget because you have
  other work to do first; in that case YOU are responsible for calling
  `opencode_job_status({ jobId })` yourself later. If you forget, nothing will
  remind you.

## The tier map is data, not a hand-picked guess

`low`/`mid`/`high`/`max` are computed (`src/rank.js`) by cross-referencing every
opencode-go model's real cost (`opencode models --verbose`) against its
WebDev/code arena score (scraped from arena.ai), splitting into cumulative cost
pools, and picking the CHEAPEST model within 1% of the pool's best score — not
just the outright top scorer, so a near-tie in score never costs a large price
premium for nothing. This refreshes automatically once a day (`src/tiers.js`'s
`isStale()` check, triggered fire-and-forget from
`opencode_start_job`/`opencode_check_go_status`/server startup) — don't assume
the mapping you saw last session still holds; a model that was `max` yesterday
may not be today if the leaderboard, Go lineup, or a recent failure moved it.

Concurrent Claude Code sessions each run their OWN opencode-mcp server
process, started with whatever code existed at THAT session's start — a
session running since before a fix landed keeps the old behavior until it's
restarted. If you (or the user) see inconsistent model choices across
sessions on the same day, check this before assuming the ranking itself is
wrong. If the user wants guaranteed-consistent model usage for a session
regardless of this, point them at `OPENCODE_MCP_PIN_MODEL` (README) — it
forces every `opencode_start_job` call in that session to one fixed model,
HARD-overriding even an explicit `model` param (that's the point: it catches
you forgetting the pin and asking for something else). If you ever see a
`warning` field in an `opencode_start_job` response, that means a pin is
active and just overrode what you actually asked for — read it, it names
both.

## Broken models are caught by real usage, not by probing — don't over-explain a `tier` failure

There is no proactive live-probe anymore (removed 2026-08-05 — it cost real
tokens on every refresh, and a too-short timeout falsely flagged a legitimately
slow reasoning model, `kimi-k3/max`, as broken). Instead: a `tier` job that
fails with a real error auto-retries the next-best candidate in the same cost
pool (if you passed `waitMs`) and blocks that model+variant with exponential
backoff (5min → 30min → 2h → 8h → 24h by consecutive failures, reset to 5min
on the next success — not a flat 24h block, which used to keep routing to a
pricier fallback for a whole day after a transient blip) so future calls skip
it immediately. If you're passing `waitMs`, you should basically
never see this failure yourself — the retry is transparent. If you DID see one
propagate (e.g. you omitted `waitMs`, or every candidate in the pool failed),
check `opencode_check_go_status`'s `blocked` field before assuming it's your
prompt; `opencode_cancel_job` still exists separately for a job that's merely
hung with no output at all (different failure mode — a hang never resolves to
"failed" on its own, so it won't trigger the auto-block; cancel it yourself).

## If a job's status seems stuck on "running" despite the work looking done

Fixed 2026-08-09 — should be rare now, but if you ever see a job whose output
files clearly exist/are complete while `opencode_job_status` still reports
`"running"`, that was a real bug: `jobs.js` used to trust only Node's `close`
event, which waits for ALL stdio pipes to close — delayed indefinitely if
`opencode run` left a descendant process (backgrounded bash, another MCP
connection) holding them open. It now also listens for `exit` (fires the
instant the process itself terminates) and settles on whichever comes first.
Don't work around a stuck status by reading files directly anymore — if you
still see this, it's worth flagging as a regression, not routing around it.

## Recovering a job whose process/memory is gone, or one that's derailed

If `opencode_job_status`/`opencode_list_jobs` says "No job with id ..." — this
process may have restarted (or it's a job a different Claude Code session
started). Try the same jobId again anyway: job state is checkpointed to disk
(`src/job-store.js`) and read back automatically if it's not in this
process's memory, so it usually still resolves. Only if that genuinely fails
do you need `sessionId` directly (from `opencode session list` or wherever
you last saw it).

If a job is technically still running but seems to have gone in circles or
lost the plot (not a hard failure — those already auto-retry, see above),
`opencode_resume_job` sends a nudge to continue that same opencode session
instead of starting over from scratch, wasting whatever progress it already
made. This is the MCP equivalent of the manual TUI recovery: find the
session, tell it there was a hiccup, let it pick back up. Prefer this over
just re-running `opencode_start_job` fresh when you suspect the underlying
work was mostly fine and something external (not the task itself) derailed it.

## When something in opencode itself changes

`opencode models`/`opencode models <provider> --verbose` are the source of
truth for what's currently on offer. If a job fails because a specific `model`
(not a `tier`) no longer exists or changed behavior, that's an explicit
override you chose — re-check `opencode_list_models`/`opencode_model_info`
rather than assuming the tier map is at fault.
