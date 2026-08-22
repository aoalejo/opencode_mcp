/**
 * QA lens catalog.
 *
 * Each lens is a NARROW, CHECKABLE instruction rather than a vague theme.
 * The original version of this file had eight one-line themes ("correctness
 * bugs", "security", ...) and in practice a weak local model answered them
 * all the same way: a wall of plausible-sounding prose that mostly restated
 * the diff. Specific lenses ("check the EXACT operator against what the
 * comment says the boundary should be, especially exactly-at-the-boundary")
 * give a weak model something it can actually mechanically verify, which is
 * where it's strongest — and they make N parallel reviewers genuinely
 * diverge instead of producing N near-duplicates.
 *
 * All prompts are in English regardless of the repo's language: the models
 * behind opencode follow English instructions more reliably.
 */

/**
 * Appended to EVERY lens prompt. The `NO FINDINGS` sentinel matters — it
 * lets both the aggregator and plain-JS code tell "this lens found nothing"
 * apart from "this lens rambled without concluding".
 */
export const FINDING_FORMAT = `
Report ONLY concrete, verifiable defects. Not style preferences, not "this could be cleaner", not speculative refactors. A finding you cannot demonstrate with a specific failing scenario is not a finding.

For EACH defect, give exactly:
1. FILE: the path
2. LOCATION: function / class / approximate line
3. WHAT: what the code actually does, versus what it should do
4. WHY WRONG: a concrete failing scenario — specific inputs leading to a specific wrong output or state
5. SEVERITY: high | medium | low

If you find nothing for your lens, reply with exactly: NO FINDINGS`;

/**
 * The six lenses the tool leads with. The first four target bug classes that
 * are cheap for a machine to check and expensive for a human to eyeball —
 * exactly the trade this whole delegation setup exists to make.
 */
export const QA_LENSES = [
  {
    key: "sign_direction",
    title: "Sign / direction correctness",
    prompt: `SIGN AND DIRECTION correctness.

Find every place the code decides between two opposed directions: gain vs loss, credit vs debit, income vs expense, increase vs decrease, origin vs destination side of a transfer, sender vs receiver, before vs after, add vs subtract, inbound vs outbound.

For each one:
- First, state the convention the codebase actually intends — read the comments, docstrings, type/field names, and (if the code is ambiguous) how the majority of CALL SITES use it. Write down that convention explicitly before judging anything.
- Then check whether this specific branch, assignment, or arithmetic matches that convention.
- Flag inverted signs, swapped operands in a subtraction, a negation applied on the wrong branch, and origin/destination (or from/to, source/target) arguments passed in the wrong order.

Pay particular attention to:
- Code where BOTH directions flow through one shared helper, and only one caller negates.
- Places where a value is already signed and the code negates it again ("double negative").
- Aggregations (sums, totals, balances) that mix already-signed values with absolute values.
- Symmetric pairs of functions (credit/debit, apply/revert, do/undo) where one side was updated and the other was not.

If the intended convention is genuinely undocumented and the call sites disagree with each other, report THAT as the finding — an ambiguous sign convention is a real defect.`,
  },
  {
    key: "boundary_offbyone",
    title: "Boundaries / off-by-one",
    prompt: `BOUNDARY AND OFF-BY-ONE correctness.

Find every comparison against a threshold, limit, date, index, count, or tolerance value, and check the EXACT operator used (\`<\` vs \`<=\`, \`>\` vs \`>=\`, \`isBefore\` vs \`isSameOrBefore\`, \`!=\` vs \`<\`) against what the surrounding comment, docstring, field name, or spec says the boundary should be.

The central question for every one of them: what happens when the value is EXACTLY AT the boundary? Not clearly above, not clearly below — exactly at it. Trace that case concretely.

Also check:
- Loop bounds: \`i < n\` vs \`i <= n\`, and loops that must visit the last element but stop one short (or run one past).
- Slice / substring / sublist / pagination arithmetic: inclusive vs exclusive ends, \`offset + limit\` overshooting, the final partial page.
- Date and period ranges: is the end of a month/quarter/day inclusive? Does a range that starts and ends on the same instant contain anything?
- Empty and single-element inputs: does a length-0 or length-1 collection take a branch intended for "many"?
- Rounding at exact halves, and float comparisons using \`==\` where a tolerance is intended (or a tolerance applied in the wrong direction).

State, for each finding, the exact input value that sits on the boundary and the wrong result it produces.`,
  },
  {
    key: "mutation_ordering",
    title: "Mutation during iteration / structural consistency",
    prompt: `MUTATION-DURING-ITERATION and DATA-STRUCTURE CONSISTENCY.

Look specifically for:
- Removing or inserting elements of a list BY INDEX inside a loop. Work out whether the traversal order actually survives the index shift after each mutation — ascending removal by index is usually wrong, descending is usually right. Do not accept it as correct because it "looks intentional"; simulate two removals concretely.
- Mutating a collection while iterating over it (adding/removing during a for-each, modifying map keys while walking the map).
- Two SYMMETRIC or PARALLEL code paths that should be handled identically but are not: two lists purged the same way where only one gets the guard, an add path and a remove path that disagree, a serializer and deserializer that treat the same field differently, a cache and its source of truth updated in only one place.
- Shared references: the same object pushed into two collections and then mutated through one of them, or a "copy" that is actually a shallow copy of something that gets mutated later.
- Ordering assumptions: code that relies on a map/set/dictionary preserving insertion order when the language or structure does not guarantee it, or that depends on two separate lists staying index-aligned after one of them is filtered.

For each finding, walk through the actual sequence of mutations step by step and show which element gets skipped, visited twice, or left behind.`,
  },
  {
    key: "priority_ordering",
    title: "Priority / tie-breaking / selection",
    prompt: `PRIORITY, TIE-BREAKING and SELECTION-ORDER correctness.

Find every place the code must pick the "best" candidate among several: closest match, smallest difference, highest score, earliest date, most specific rule, first applicable handler.

For each one, verify that the actual loop or comparison implements the priority rule the surrounding comments, class documentation, or function name CLAIM it implements. Specifically:
- Loops that should find the globally-best candidate but only compare locally or greedily — e.g. keeping the first candidate that beats the running value, in a way that depends on input order rather than on the real ranking.
- A "best match" search that returns early on the first acceptable candidate when it was supposed to keep looking for a better one.
- Tie-breaks that silently prefer the wrong one: first-found vs last-found, and whether that choice is deliberate or accidental. Say what happens when two candidates score EXACTLY equal.
- Sorts relied upon to be stable where stability is not guaranteed, or a multi-key sort whose keys are applied in the wrong order of importance.
- Rule/handler chains where a broad catch-all is checked before a more specific rule, shadowing it permanently.
- Comparators that are inconsistent (can report a > b and b > a) or that mix types.

For each finding, construct a specific set of two or three candidates where the code picks the wrong one, and say which one it should have picked.`,
  },
  {
    key: "security",
    title: "Security",
    prompt: `SECURITY defects.

Check specifically for:
- Authentication and authorization: missing permission checks on an operation that mutates or reads someone else's data; a check performed on the client or in the UI layer but not where the operation actually executes; an ownership check that compares the wrong id; role checks that fail open (default-allow) rather than fail closed.
- Injection: SQL/NoSQL query construction by string concatenation, shell commands built from input, path traversal via unsanitized filenames, template or HTML rendering of untrusted values, unsafe deserialization of external data.
- Credential and secret handling: hardcoded keys, tokens, or passwords; secrets in URLs, query strings, or log lines; credentials committed to config that ships to a client; secrets that survive in error messages or stack traces.
- Insecure storage and transport: sensitive data written to plaintext local storage/preferences/cache, missing encryption at rest where the surrounding code implies it, disabled TLS/certificate verification.
- Unsafe defaults: a permission, visibility, or sharing flag whose default is the permissive value; a feature flag that opens access when a config lookup fails.
- Data exposure: an endpoint or query returning more fields than the caller should see; a list operation that omits the per-tenant/per-user filter.

Judge against what this code can actually reach — do not report a theoretical concern that is impossible given the surrounding validation. For each finding, state concretely who could exploit it and what they would obtain.`,
  },
  {
    key: "performance",
    title: "Performance",
    prompt: `PERFORMANCE defects.

Check specifically for:
- N+1 access patterns: a query, network call, file read, or expensive lookup issued inside a loop where one batched call would do.
- Unbounded work: loops or recursive walks over collections with no size limit, queries with no pagination or LIMIT, reading an entire file/collection into memory when a stream or a filtered query would do, growth that is quadratic in input size (nested scans, repeated \`indexOf\`/\`includes\` inside a loop over the same collection).
- Blocking on a hot path: synchronous I/O, synchronous JSON parse of large payloads, or CPU-heavy work executed on a UI thread, request handler, or event loop where it will stall everything behind it.
- Repeated recomputation: the same derived value, sort, regex compilation, or expensive parse recomputed on every iteration or every render instead of being hoisted or memoized — and the reverse mistake, a cache that is never invalidated when its source changes.
- Wasted work: fetching or computing data that is then discarded by a filter that could have been applied earlier; awaiting sequentially a set of independent async calls that could run concurrently.

Only report things where you can name the input scale that makes it hurt ("with ~500 rows this issues 500 separate reads"). Do not report micro-optimizations with no measurable effect.`,
  },
];

/**
 * Additional lenses, same style. Not in the default set — they widen
 * coverage when the participant count is high enough to afford them, or when
 * a caller selects them explicitly via the `lenses` param.
 */
export const EXTRA_LENSES = [
  {
    key: "null_empty",
    title: "Null / empty / missing-value handling",
    prompt: `NULL, EMPTY and MISSING-VALUE handling.

Check every place a value can legitimately be absent and verify the code distinguishes the cases it needs to:
- "absent / not yet loaded" versus "present and zero", "present and empty string", or "present and empty list". Conflating these is the core bug of this lens — look for \`if (!value)\`, \`if (value)\`, truthiness checks, and \`||\` defaults applied to values where 0, "", or false are legitimate.
- Optional chaining or null-coalescing that silently produces a wrong default instead of surfacing a real error.
- A non-null assertion, force-unwrap, or cast that assumes something the caller does not actually guarantee.
- Collections: does an empty collection take the "no data" branch, or does it fall through into aggregate math (average of zero items, max of an empty list, division by a count that can be 0)?
- Fields that are optional in the data model but read as required, especially after a schema or API change.

For each finding, name the specific absent/zero/empty value and the wrong result it produces.`,
  },
  {
    key: "error_handling",
    title: "Error handling",
    prompt: `ERROR HANDLING defects.

Check for:
- Swallowed errors: a catch block that logs nothing and rethrows nothing, or that returns a default which makes a failure indistinguishable from a legitimate result.
- Over-broad catches that hide programming errors (a catch-all wrapping a large block, catching a base exception type to handle one expected failure).
- Failure modes that mislead: an error path that reports success, a partial write left committed after a mid-operation failure, a retry that duplicates a non-idempotent side effect.
- Missing validation at real trust boundaries — where external input, a network response, or a file first enters the system — as opposed to redundant re-validation of already-checked internal values.
- Errors surfaced with no actionable information (message discarded, original cause not chained).
- Cleanup that does not run on the failure path: unreleased locks, unclosed handles, listeners never removed, loading state never cleared.

For each finding, describe the failure that gets hidden and what the user or caller sees instead.`,
  },
  {
    key: "concurrency",
    title: "Concurrency / async",
    prompt: `CONCURRENCY and ASYNC defects.

Check for:
- Missing \`await\` (or equivalent): an async call whose result or completion is required but not waited for, producing a race between it and the code that follows.
- Read-modify-write races on shared mutable state, including two async handlers that can interleave on the same object, counter, or cache.
- Order assumptions between independently-scheduled operations that are not actually guaranteed to complete in that order.
- Stale closures and captured state: an async callback that uses a value captured before an await, after that value has been replaced.
- Operations that can run twice: a button/handler/trigger with no in-flight guard, a retry layered on a non-idempotent action.
- Cancellation and teardown: work that continues after its owner is disposed, writing to state that no longer exists; subscriptions or timers never cancelled.
- Deadlock or permanent-pending states: a lock acquired and not released on every path, a promise that can never settle on some branch.

For each finding, describe the concrete interleaving — which two operations, in what order — that produces the wrong result.`,
  },
  {
    key: "contract_mismatch",
    title: "Doc / contract mismatch",
    prompt: `CONTRACT MISMATCH between what is documented and what is implemented.

Compare each function, class, or module's stated contract — its docstring, comments, name, and type signature — against what the body actually does:
- A comment or docstring that describes behavior the code no longer has (stale after a change).
- A name that promises something different from the implementation (\`getActiveUsers\` that also returns archived ones, \`validateX\` that mutates, \`isY\` that has side effects).
- Documented preconditions, ranges, units, or return values that the code does not honor — especially UNITS (cents vs currency units, seconds vs milliseconds, percent as 0-1 vs 0-100) and TIMEZONE assumptions.
- Caller expectations: find the actual call sites and check whether they rely on a guarantee the callee does not really provide (never returns null, always sorted, always non-empty, idempotent).
- Two implementations of the same interface that disagree about an edge case the interface leaves implicit.

For each finding, quote the documented claim and show the code path that violates it.`,
  },
  {
    key: "state_consistency",
    title: "Derived state / cache consistency",
    prompt: `DERIVED-STATE and CACHE CONSISTENCY defects.

Look for state that can drift out of sync with its source of truth:
- The same fact stored in two places, where only one is updated on some code path.
- Derived or denormalized values (totals, counts, flags, summaries) recomputed on some mutations but not all.
- Caches and memoized values with no invalidation, invalidated on only some of the paths that change their inputs, or keyed on something that does not capture every input.
- Local/optimistic state updated ahead of a remote write that can fail, with no rollback.
- Ordering between a write and the read that refreshes derived state (refresh issued before the write commits).
- Initialization and reset paths that clear some of the related state but not all of it, leaving a half-reset object.

For each finding, describe the exact sequence of operations after which the two representations disagree, and what a user would then see.`,
  },
  {
    key: "test_gaps",
    title: "Test coverage gaps",
    prompt: `TEST COVERAGE gaps, judged against the code actually under review.

Identify:
- New or changed behavior with no test exercising it at all.
- Tests that exercise only the happy path for logic whose interesting behavior is at the edges — name the specific untested edge case (boundary value, empty input, failure branch, exactly-equal tie).
- Tests that assert something weaker than what they appear to check: asserting a widget/element merely renders rather than that it shows the right value, asserting "no exception thrown" instead of the result, snapshot assertions over logic that deserves an explicit expectation.
- Tests whose fixture data cannot distinguish correct from incorrect behavior — e.g. a sort test whose input is already sorted, a sign test where the expected value is symmetric, a single-element fixture for a function whose bug only appears with several.
- Branches that are unreachable from any existing test's inputs.

Do not simply list every function without a test. Prioritize by which missing test would actually have caught a plausible bug, and say which bug.`,
  },
];

export const ALL_LENSES = [...QA_LENSES, ...EXTRA_LENSES];
export const DEFAULT_LENS_KEYS = QA_LENSES.map((l) => l.key);
export const ALL_LENS_KEYS = ALL_LENSES.map((l) => l.key);

/**
 * Resolve caller-supplied lens selection to lens objects. Accepts an array
 * of keys, or the string "all" for every lens including the extras. Unknown
 * keys are returned separately rather than silently ignored — a typo'd lens
 * key quietly reviewing nothing is exactly the kind of silent-wrong this
 * project avoids elsewhere.
 */
export function resolveLenses(selection) {
  if (selection === "all") return { lenses: ALL_LENSES, unknown: [] };
  const keys = Array.isArray(selection) ? selection : null;
  if (!keys || !keys.length) return { lenses: QA_LENSES, unknown: [] };
  if (keys.length === 1 && keys[0] === "all") return { lenses: ALL_LENSES, unknown: [] };
  const byKey = new Map(ALL_LENSES.map((l) => [l.key, l]));
  const lenses = [];
  const unknown = [];
  for (const k of keys) {
    const lens = byKey.get(k);
    if (lens) lenses.push(lens);
    else unknown.push(k);
  }
  return { lenses: lenses.length ? lenses : QA_LENSES, unknown };
}

/** Every lens must get at least this many independent reviewers — redundancy is the whole point. */
export const MIN_REPLICAS = 2;

/**
 * Decide who reviews what.
 *
 * Default model is REPLICAS: every selected lens gets `replicas` independent
 * reviewers (never fewer than MIN_REPLICAS). That's deliberately different
 * from spreading a flat participant count round-robin — with round-robin,
 * some lenses ended up with 3 reviewers and others with 2, so the
 * "2+ participants agreeing = CONFIRMED" rule meant different things
 * depending on which lens you drew. With uniform replicas, corroboration is
 * measured within a lens against a known denominator.
 *
 * An explicit `count` still overrides that and round-robins to exactly that
 * many participants, for callers that care about total spend more than about
 * even coverage.
 *
 * Returns one entry per participant: its lens, its ordinal within that lens,
 * and how many reviewers that lens has in total (used to nudge same-lens
 * reviewers onto different angles instead of re-deriving one answer).
 */
export function planParticipants({ lenses, replicas, count, maxParticipants = 50 }) {
  const notes = [];
  let assignments = [];

  if (Number.isInteger(count) && count > 0) {
    const n = Math.min(count, maxParticipants);
    if (n < count) notes.push(`count clamped from ${count} to ${n} (MAX_PARTICIPANTS)`);
    const totals = new Map();
    for (let i = 0; i < n; i++) {
      const lens = lenses[i % lenses.length];
      totals.set(lens.key, (totals.get(lens.key) ?? 0) + 1);
    }
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const lens = lenses[i % lenses.length];
      const nth = (seen.get(lens.key) ?? 0) + 1;
      seen.set(lens.key, nth);
      assignments.push({ lens, nth, totalForLens: totals.get(lens.key) });
    }
    if (n < lenses.length) {
      notes.push(`count ${n} is below the ${lenses.length} selected lenses — lenses after the first ${n} got no reviewer`);
    }
    return { assignments, replicas: null, count: n, notes };
  }

  let effectiveReplicas = Number.isInteger(replicas) ? replicas : MIN_REPLICAS;
  if (effectiveReplicas < MIN_REPLICAS) {
    notes.push(`replicas raised from ${effectiveReplicas} to the ${MIN_REPLICAS} minimum (redundancy is required for corroboration)`);
    effectiveReplicas = MIN_REPLICAS;
  }
  const maxReplicas = Math.max(MIN_REPLICAS, Math.floor(maxParticipants / lenses.length));
  if (effectiveReplicas > maxReplicas) {
    notes.push(`replicas reduced from ${effectiveReplicas} to ${maxReplicas} so ${lenses.length} lenses fit under MAX_PARTICIPANTS`);
    effectiveReplicas = maxReplicas;
  }

  for (const lens of lenses) {
    for (let r = 1; r <= effectiveReplicas; r++) {
      assignments.push({ lens, nth: r, totalForLens: effectiveReplicas });
    }
  }
  if (assignments.length > maxParticipants) {
    notes.push(`participant list truncated from ${assignments.length} to ${maxParticipants} (MAX_PARTICIPANTS)`);
    assignments = assignments.slice(0, maxParticipants);
  }
  return { assignments, replicas: effectiveReplicas, count: assignments.length, notes };
}
