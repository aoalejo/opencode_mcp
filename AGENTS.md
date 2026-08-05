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
WebDev/code arena score (scraped from arena.ai), splitting into 4 cost bands,
and taking the best-scoring, live-verified model per band. This refreshes
automatically once a day (`src/tiers.js`'s `isStale()` check, triggered
fire-and-forget from `opencode_start_job`/`opencode_check_go_status`/server
startup) — don't assume the mapping you saw last session still holds; a model
that was `max` yesterday may not be today if the leaderboard or Go lineup moved.

## Reliability notes (observed, may go stale)

- OpenCode Go models: availability and responsiveness has varied — some hang
  indefinitely with no output, some return region-lock errors (observed with
  `deepseek-v4-flash`, which is otherwise a great cheap/high-scoring pick).
  `opencode_cancel_job` exists for the hang case. The tier ranker already
  live-probes and falls through to the next-best candidate in a band before
  saving, so a region-locked top pick shouldn't normally reach you — but if a
  job using a `tier` fails outright, check `opencode_check_go_status` before
  assuming it's your prompt.

## When something in opencode itself changes

`opencode models`/`opencode models <provider> --verbose` are the source of
truth for what's currently on offer. If a job fails because a specific `model`
(not a `tier`) no longer exists or changed behavior, that's an explicit
override you chose — re-check `opencode_list_models`/`opencode_model_info`
rather than assuming the tier map is at fault.
