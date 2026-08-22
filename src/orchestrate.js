import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { startJob, getJob, waitForJob, jobSummary } from "./jobs.js";
import { resolveModel, pinnedModel } from "./tiers.js";
import { ALL_LENS_KEYS, FINDING_FORMAT, resolveLenses, planParticipants } from "./lenses.js";

// Registered once in ~/.config/opencode/opencode.jsonc: permission.edit/bash/
// task/skill all "deny" — a genuine forced-read-only agent (not just a
// prompted instruction the model could ignore), used by audit/investigate
// (all participants + every aggregator/adversarial round) and by goal's
// final verifier.
export const READONLY_AGENT = "mcp-readonly";

export const MAX_PARTICIPANTS = 50;

// Above this rough token estimate (chars/4), a diff is too big to hand every
// participant in full — instead each participant gets only the files
// assigned to them (round-robin), reviewed independently.
const LARGE_DIFF_TOKEN_THRESHOLD = 100_000;

const HANDOFF_SUFFIX =
  "\n\n---\nRespond with only your findings/answer — no preamble, no restating " +
  "the task, no narrating tool use.";

// Files checked, in order, for repo-wide context to hand every reviewer
// (architecture, domain conventions, invariants). A weak model reviewing a
// financial ledger without knowing "distributions count as an expense here"
// reports confident nonsense; a paragraph of domain context prevents a whole
// category of false positives.
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md"];
const CONTEXT_MAX_CHARS = 12000;

/**
 * Load repo-wide context to prepend to every reviewer's prompt. An explicit
 * `contextFile` wins; otherwise the first of CONTEXT_FILE_CANDIDATES that
 * exists is used. Returns null when there's nothing to add (never throws —
 * missing context degrades review quality, it shouldn't fail the run).
 */
export function loadProjectContext({ dir, contextFile }) {
  const base = dir || process.cwd();
  const candidates = contextFile ? [contextFile] : CONTEXT_FILE_CANDIDATES;
  for (const name of candidates) {
    const full = path.isAbsolute(name) ? name : path.join(base, name);
    try {
      if (!existsSync(full)) continue;
      const raw = readFileSync(full, "utf8");
      if (!raw.trim()) continue;
      const truncated = raw.length > CONTEXT_MAX_CHARS;
      return {
        path: full,
        text: truncated ? `${raw.slice(0, CONTEXT_MAX_CHARS)}\n\n[...truncated for length...]` : raw,
        truncated,
      };
    } catch {
      // unreadable candidate — try the next one
    }
  }
  return null;
}

/**
 * Compact one-liners for findings already confirmed earlier in a sweep, so
 * later segments don't burn their whole review re-reporting the same bug.
 * Deliberately tells reviewers to hunt for SIMILAR instances rather than to
 * ignore the area entirely — a confirmed bug class is a lead, not a no-go.
 */
function formatKnownFindings(knownFindings, refutedFindings, cap = 40) {
  const confirmed = (knownFindings || []).filter(Boolean);
  const refuted = (refutedFindings || []).filter(Boolean);
  if (!confirmed.length && !refuted.length) return null;

  const sections = [];
  if (confirmed.length) {
    const shown = confirmed.slice(-cap);
    const omitted = confirmed.length - shown.length;
    sections.push(
      `ALREADY-CONFIRMED FINDINGS (reported and verified earlier in this run — do NOT re-report them):\n` +
        shown.map((f) => `- [${f.lens ?? "?"}] ${f.location ?? "?"} — ${f.title ?? ""}`.trim()).join("\n") +
        (omitted > 0 ? `\n- ...and ${omitted} earlier finding(s) omitted for length.` : "")
    );
  }
  if (refuted.length) {
    const shown = refuted.slice(-cap);
    const omitted = refuted.length - shown.length;
    sections.push(
      `ALREADY-REFUTED CLAIMS (raised earlier in this run and then DISPROVEN under adversarial review — ` +
        `do not raise them again unless you have new evidence the earlier refutation missed):\n` +
        shown.map((f) => `- [${f.lens ?? "?"}] ${f.location ?? "?"} — ${f.title ?? ""}`.trim()).join("\n") +
        (omitted > 0 ? `\n- ...and ${omitted} earlier refuted claim(s) omitted for length.` : "")
    );
  }
  sections.push(
    `Do not spend effort re-confirming or re-litigating anything above. DO actively look for OTHER, DISTINCT ` +
      `instances of the same bug classes elsewhere in the code you are reviewing now — a confirmed bug pattern ` +
      `usually repeats. Report only new occurrences at new locations.`
  );
  return sections.join("\n\n");
}

/**
 * Instruction appended to the FINAL aggregator so it emits, after its prose
 * report, a compact machine-readable list of confirmed findings. Parsed in
 * plain JS (see parseFindingsBlock) rather than by another LLM call — one
 * less thing to go wrong, and it degrades to "carry nothing forward" instead
 * of failing if the model ignores the format.
 */
const FINDINGS_BLOCK_INSTRUCTION = `

Finally, AFTER the prose report, output one fenced block in exactly this format (a program parses it, so keep the format exact):

\`\`\`findings
[lens_key] path/to/file.ext:location | severity | one-line title
\`\`\`

One line per CONFIRMED or ADVERSARIALLY CONFIRMED finding only — never low-confidence, never refuted ones. Severity must be high, medium, or low. If there are no confirmed findings, output the fenced block empty.

Then, if any claim was REFUTED (raised by a reviewer and then convincingly disproven), output a second fenced block in the same shape listing those instead, so later reviewers don't raise them again:

\`\`\`refuted
[lens_key] path/to/file.ext:location | why it was refuted
\`\`\`

Omit this second block entirely if nothing was refuted.`;

/**
 * Parse the compact findings block emitted per FINDINGS_BLOCK_INSTRUCTION.
 * Returns [] if absent/unparseable.
 *
 * Deliberately lenient about the lens field: models routinely drop the square
 * brackets (observed on the very first real sweep — every finding was
 * correctly identified and then thrown away by a stricter regex). Anchoring
 * on the pipe-separated fields and treating the brackets as optional keeps a
 * good answer from being lost to a formatting slip.
 */
function parseTaggedBlock(text, blockName, { hasSeverity }) {
  if (!text) return [];
  const block = text.match(new RegExp("```" + blockName + "\\s*([\\s\\S]*?)```"));
  if (!block) return [];
  const minFields = hasSeverity ? 3 : 2;
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length < minFields) return null;
      const head = parts[0].replace(/^[-*]\s*/, "").trim();
      if (!head || /^path\/to\//i.test(head)) return null; // the format template echoed back

      let lens = null;
      let location = head;
      const bracketed = head.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (bracketed) {
        lens = bracketed[1].trim();
        location = bracketed[2].trim();
      } else {
        // Unbracketed. The leading token may be one lens key, or several
        // comma-joined ones when a finding was corroborated across lenses.
        const spaced = head.match(/^(\S+)\s+(.+)$/);
        if (spaced) {
          const keys = spaced[1].split(",").map((k) => k.trim()).filter(Boolean);
          if (keys.length && keys.every((k) => ALL_LENS_KEYS.includes(k))) {
            lens = keys.join(",");
            location = spaced[2].trim();
          }
        }
      }
      if (!location) return null;

      if (!hasSeverity) {
        return { lens: lens ?? "unspecified", location, title: parts.slice(1).join(" | ").trim() };
      }
      const severity = parts[1].toLowerCase();
      return {
        lens: lens ?? "unspecified",
        location,
        severity: ["high", "medium", "low"].includes(severity) ? severity : "medium",
        title: parts.slice(2).join(" | ").trim(),
      };
    })
    .filter(Boolean);
}

export function parseFindingsBlock(text) {
  return parseTaggedBlock(text, "findings", { hasSeverity: true });
}

/** Claims raised and then disproven — carried forward so later segments don't re-litigate them. */
export function parseRefutedBlock(text) {
  return parseTaggedBlock(text, "refuted", { hasSeverity: false });
}

function git(dir, args, maxBuffer = 20 * 1024 * 1024) {
  return execFileSync("git", args, { cwd: dir || process.cwd(), maxBuffer }).toString("utf8");
}

/**
 * Either the uncommitted working-tree diff (`git diff HEAD`, default), or —
 * when `baseCommit` is given — everything since that commit (`git diff
 * <baseCommit> HEAD`), for reviewing a whole feature branch/PR rather than
 * just what's currently uncommitted. Also returns the changed file list,
 * used by the large-diff file-partition fallback below.
 */
export function getDiff({ dir, baseCommit }) {
  if (baseCommit) {
    const diff = git(dir, ["diff", baseCommit, "HEAD"], 50 * 1024 * 1024);
    const files = git(dir, ["diff", "--name-only", baseCommit, "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
    return { diff, status: "", files, mode: "commit", base: baseCommit };
  }
  const diff = git(dir, ["diff", "HEAD"], 50 * 1024 * 1024);
  const status = git(dir, ["status", "--porcelain"], 5 * 1024 * 1024);
  const files = git(dir, ["diff", "--name-only", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
  return { diff, status, files, mode: "uncommitted", base: null };
}

/** Diff restricted to a subset of files — used when the full diff is too large to hand every participant in full. */
function getDiffForFiles({ dir, baseCommit, files }) {
  if (!files.length) return "";
  const refArgs = baseCommit ? [baseCommit, "HEAD"] : ["HEAD"];
  return git(dir, ["diff", ...refArgs, "--", ...files], 20 * 1024 * 1024);
}

const FREE_LOCAL_MODEL_PREFIXES = ["local-qwen/"];
function isFreeLocalModel(modelId) {
  return typeof modelId === "string" && FREE_LOCAL_MODEL_PREFIXES.some((p) => modelId.startsWith(p));
}
function defaultWidth({ model, tier }, wide, narrow) {
  if (model) return isFreeLocalModel(model) ? wide : narrow;
  const pin = pinnedModel();
  if (pin) return isFreeLocalModel(pin.model) ? wide : narrow;
  return narrow;
}

function clampCount(count, fallback) {
  const n = Number.isInteger(count) ? count : fallback;
  return Math.max(1, Math.min(MAX_PARTICIPANTS, n));
}

function clampDepth(depth) {
  const n = Number(depth);
  return Math.max(0, Math.min(3, Number.isFinite(n) ? n : 1));
}

/** Read package.json's `scripts.lint`/`scripts.test` to default the check commands when the caller doesn't specify them. */
function detectChecks(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir || process.cwd(), "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    return { lintCommand: scripts.lint ? "npm run lint" : null, testCommand: scripts.test ? "npm test" : null };
  } catch {
    return { lintCommand: null, testCommand: null };
  }
}

/**
 * Run one real lint/test command and capture its actual pass/fail + output —
 * mechanical ground truth, not another LLM opinion. A weak model trusting
 * only its own self-report ("done!") is unreliable; reacting to a real exit
 * code and real stderr is much less so.
 */
function runCheck(dir, command, label, timeoutMs) {
  if (!command) return null;
  const startedAt = Date.now();
  try {
    const output = execSync(command, { cwd: dir || process.cwd(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: true }).toString("utf8");
    return { label, command, passed: true, exitCode: 0, output: output.slice(-4000), durationMs: Date.now() - startedAt };
  } catch (e) {
    const combined = `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message ?? e);
    return {
      label,
      command,
      passed: false,
      exitCode: e.status ?? null,
      timedOut: e.signal === "SIGTERM",
      output: combined.slice(-4000),
      durationMs: Date.now() - startedAt,
    };
  }
}

function formatChecksForPrompt(checks) {
  const list = (checks || []).filter(Boolean);
  if (!list.length) return null;
  return list
    .map((c) => `### ${c.label} (${c.passed ? "PASSED" : "FAILED"}${c.timedOut ? ", TIMED OUT" : ""})\nCommand: ${c.command}\n${c.output || "(no output)"}`)
    .join("\n\n");
}

/**
 * Strip a raw jobSummary down to what's actually worth handing back to the
 * MCP caller. `prompt` is dropped UNCONDITIONALLY — it's whatever this
 * function built for the job (often the full diff or the full running
 * report), already known to the caller or redundant with the reconciled
 * result, and multiplying it across N participants is pure bloat (observed
 * 2026-08-19: a 16-participant audit's `participants[].prompt` alone was
 * 650KB of a 773KB response, next to a 5KB actual answer). `dir`/`sessionId`/
 * `agent`/`exitCode`/`stderrTail`/`startedAt`/`finishedAt` are internal
 * bookkeeping the caller has no use for here either. `text` (the participant's
 * own findings) is kept only when `keepText` is true — default responses
 * return just the reconciled report; pass `verbose: true` on the tool to see
 * each individual participant/pass's raw output for debugging.
 */
function trimJob(summary, { keepText = false } = {}) {
  const trimmed = {
    jobId: summary.jobId,
    status: summary.status,
    model: summary.model,
    variant: summary.variant,
    tokens: summary.tokens,
    cost: summary.cost,
    errorMessage: summary.errorMessage,
    durationMs: summary.durationMs,
  };
  if (keepText) trimmed.text = summary.text;
  return trimmed;
}

/**
 * Fan `count` jobs out IN PARALLEL (all started before any waitForJob), all
 * pinned to the same resolved model+variant and forced onto READONLY_AGENT so
 * "solo lectura forzado" is an actual permission-engine guarantee, not a
 * prompt request a model could ignore. Returns each participant's FULL
 * summary (including `text`/`prompt`) — this is the internal shape used to
 * build reconciliation prompts; callers returning this to the MCP layer must
 * trim it first via `trimJob`.
 */
async function runReadOnlyBatch({ count, buildPrompt, dir, model, variant, tier, waitMs, titlePrefix }) {
  const resolved = resolveModel({ model, variant, tier });
  const jobIds = [];
  for (let i = 0; i < count; i++) {
    const jobId = startJob({
      prompt: buildPrompt(i, count) + HANDOFF_SUFFIX,
      model: resolved.model,
      variant: resolved.variant,
      agent: READONLY_AGENT,
      dir,
      title: `${titlePrefix}-${i + 1}-of-${count}`,
    });
    jobIds.push(jobId);
  }
  await Promise.all(jobIds.map((id) => waitForJob(id, waitMs)));
  return jobIds.map((id, i) => ({ index: i, ...jobSummary(getJob(id)) }));
}

/** One read-only job that reconciles a set of labeled text sources into a single report. */
async function aggregate({ instructions, sources, dir, model, variant, tier, waitMs, title }) {
  const resolved = resolveModel({ model, variant, tier });
  const body = sources
    .map((s) => {
      const label = s.status === "completed" || s.status === undefined ? s.text || "(no output)" : `[${s.status}] ${s.errorMessage ?? "(no output)"}`;
      return `### ${s.label}\n${label}`;
    })
    .join("\n\n");
  const jobId = startJob({
    prompt: `${instructions}\n\n${body}${HANDOFF_SUFFIX}`,
    model: resolved.model,
    variant: resolved.variant,
    agent: READONLY_AGENT,
    dir,
    title,
  });
  await waitForJob(jobId, waitMs);
  return jobSummary(getJob(jobId));
}

/**
 * Confidence-ranked, adversarially-verified reconciliation. Shape (matches
 * the flow as specced, not a rigid per-finding JSON pipeline — the LLM does
 * the counting/ranking in prose, kept simple on purpose):
 *
 *   round 0: N participants' raw findings -> ONE aggregator report. The
 *            aggregator is told to note how many participants corroborated
 *            each finding — 2+ = confirmed, 1 = low confidence.
 *   round 1..depth: N FRESH adversarial reviewers, each given ONLY the
 *            current report (+ shared context) and told "a low-confidence
 *            agent reported this, your job is to determine its falseness" —
 *            then ONE more aggregator reconciles [previous report + all N
 *            adversarial reviews] into an updated report (promoting anything
 *            that survived, calling out anything refuted, never silently
 *            dropping it). `depth` controls how many times this
 *            adversarial-round-then-reaggregate step repeats.
 *
 * Returns { report (final markdown/text), depth, rounds (per-stage job
 * metadata for debugging), finalJob }.
 */
async function reconcileRecursive({ participants, context, depth, count, dir, model, variant, tier, waitMs, emitFindingsBlock = false }) {
  const depthVal = clampDepth(depth);
  const rounds = [];
  // Only the LAST aggregation emits the machine-readable block — asking every
  // round for it would just be parsed and thrown away until the final one.
  const blockIf = (isFinal) => (emitFindingsBlock && isFinal ? FINDINGS_BLOCK_INSTRUCTION : "");

  let report = await aggregate({
    instructions:
      `You are the aggregator for an independent multi-agent review. ${context}\n\n` +
      `Below are ${participants.length} independent participants' findings. Build ONE unified report: merge ` +
      `overlapping findings, and for EACH finding explicitly note how many of the ${participants.length} ` +
      `participants raised it. Treat anything raised by only 1 participant as LOW CONFIDENCE and label it as such; ` +
      `anything raised by 2 or more is CONFIRMED. Drop anything that's clearly not a real issue. Rank by severity.` +
      blockIf(depthVal === 0),
    sources: participants.map((p, i) => ({ label: `Participant ${i + 1}${p.lens ? ` (lens: ${p.lens})` : ""}`, text: p.text, status: p.status, errorMessage: p.errorMessage })),
    dir,
    model,
    variant,
    tier,
    waitMs,
    title: "mcp-aggregate-r0",
  });
  rounds.push({ stage: "aggregate", round: 0, status: report.status, tokens: report.tokens, cost: report.cost });

  if (report.status !== "completed") {
    return { report: report.text || "", depth: depthVal, rounds, finalJob: { status: report.status, errorMessage: report.errorMessage }, incomplete: true };
  }

  for (let round = 1; round <= depthVal; round++) {
    const adversarialPrompt = (i, total) =>
      `Un agente de baja confianza reportó lo siguiente en esta auditoría — tu deber es determinar su falsedad. ` +
      `Sos el revisor adversarial #${i + 1} de ${total}: examiná el reporte de forma independiente e intentá refutar ` +
      `cualquier hallazgo marcado como LOW CONFIDENCE (los ya CONFIRMED no necesita tu escrutinio, salvo que veas algo ` +
      `mal ahí también). Tenés acceso read-only al repo — usalo para verificar contra el código real, no confíes en el ` +
      `reporte a ciegas. Para cada low-confidence finding que revises, decí explícitamente si te parece REAL o un FALSO ` +
      `POSITIVO, con tu justificación.\n\nREPORTE A AUDITAR:\n${report.text}\n\n${context}`;

    const adversaries = await runReadOnlyBatch({
      count,
      buildPrompt: adversarialPrompt,
      dir,
      model,
      variant,
      tier,
      waitMs,
      titlePrefix: `mcp-adversarial-r${round}`,
    });
    rounds.push({ stage: "adversarial", round, jobs: adversaries.map((a) => ({ status: a.status, tokens: a.tokens, cost: a.cost })) });

    const reaggregated = await aggregate({
      instructions:
        `You are the aggregator, reconciliation round ${round + 1}. Below is the PREVIOUS report, followed by ` +
        `${count} independent adversarial reviews that tried to refute its low-confidence findings. Build an UPDATED ` +
        `unified report: promote any low-confidence finding that survived adversarial scrutiny (label it ` +
        `"adversarially confirmed", noting it started single-source but held up), call out and separately list ` +
        `anything the adversaries convincingly refuted (never silently delete it — keep it visible for transparency), ` +
        `and keep everything already confirmed as-is. ${context}` +
        blockIf(round === depthVal),
      sources: [
        { label: "Previous report", text: report.text, status: report.status },
        ...adversaries.map((a, i) => ({ label: `Adversarial reviewer ${i + 1}`, text: a.text, status: a.status, errorMessage: a.errorMessage })),
      ],
      dir,
      model,
      variant,
      tier,
      waitMs,
      title: `mcp-aggregate-r${round}`,
    });
    rounds.push({ stage: "aggregate", round, status: reaggregated.status, tokens: reaggregated.tokens, cost: reaggregated.cost });

    if (reaggregated.status !== "completed") {
      return { report: report.text, depth: depthVal, rounds, finalJob: { status: reaggregated.status, errorMessage: reaggregated.errorMessage }, incomplete: true };
    }
    report = reaggregated;
  }

  return {
    report: report.text,
    findings: emitFindingsBlock ? parseFindingsBlock(report.text) : [],
    refuted: emitFindingsBlock ? parseRefutedBlock(report.text) : [],
    depth: depthVal,
    rounds,
    finalJob: { status: report.status, tokens: report.tokens, cost: report.cost },
  };
}

/**
 * The shared engine behind `audit` and each `sweep` segment: assign lenses to
 * participants, fan them out read-only in parallel over one body of code,
 * then run confidence-ranked adversarial reconciliation over their findings.
 *
 * `contentSection` is whatever the reviewers should look at (a diff, or a set
 * of file contents). `scopeLabel` names it in prose. Everything else —
 * project context, already-known findings, lens assignment — is layered on
 * identically for both callers so the two paths can't drift apart.
 */
async function runLensSwarm({
  scopeLabel,
  contentSection,
  contentSummaryForAggregator,
  lenses,
  replicas,
  count,
  depth,
  dir,
  model,
  variant,
  tier,
  waitMs,
  focus,
  projectContext,
  knownFindings,
  refutedFindings,
  titlePrefix,
  emitFindingsBlock = false,
  roamHint,
}) {
  const plan = planParticipants({ lenses, replicas, count, maxParticipants: MAX_PARTICIPANTS });
  const { assignments } = plan;
  const contextBlock = projectContext
    ? `PROJECT CONTEXT (from ${path.basename(projectContext.path)}) — use this to understand the domain's conventions and invariants before judging anything:\n\n${projectContext.text}\n\n---\n\n`
    : "";
  const knownBlock = formatKnownFindings(knownFindings, refutedFindings);

  const buildPrompt = (i) => {
    const { lens, nth, totalForLens } = assignments[i];
    const dupNudge =
      totalForLens > 1
        ? `\n\nYou are reviewer ${nth} of ${totalForLens} independently assigned to this same lens. Work the lens your own way; do not assume the others will cover any particular part of it. If several angles are possible, favour one the others are less likely to take.`
        : "";
    return (
      `${contextBlock}` +
      `You are performing a focused QA review of ${scopeLabel}.\n\n` +
      `YOUR LENS — review ONLY through this lens, ignore everything else:\n${lens.prompt}${dupNudge}\n\n` +
      `${focus ? `ADDITIONAL FOCUS FROM THE REQUESTER: ${focus}\n\n` : ""}` +
      `${knownBlock ? `${knownBlock}\n\n` : ""}` +
      `${contentSection}\n\n` +
      `${roamHint ?? "You have read-only access to the whole repository — use read/grep/glob/list freely to follow a flow across other files, check a caller, or confirm a convention. You cannot edit anything."}\n` +
      `${FINDING_FORMAT}`
    );
  };

  const raw = await runReadOnlyBatch({
    count: assignments.length,
    buildPrompt,
    dir,
    model,
    variant,
    tier,
    waitMs,
    titlePrefix,
  });
  const participants = raw.map((p, i) => ({ ...p, lens: assignments[i].lens.key, lensTitle: assignments[i].lens.title }));

  const lensSummary = [...new Set(assignments.map((a) => a.lens.key))].join(", ");
  const context =
    `${assignments.length} independent read-only reviewers examined ${scopeLabel}, split across these QA lenses ` +
    `(${lensSummary}) with ${plan.replicas ?? "a round-robin"} reviewer(s) per lens.\n\n${contentSummaryForAggregator ?? ""}`;

  const reconciliation = await reconcileRecursive({
    participants,
    context,
    depth,
    count: assignments.length,
    dir,
    model,
    variant,
    tier,
    waitMs,
    emitFindingsBlock,
  });

  return { participants, reconciliation, plan };
}

/**
 * `audit`: forced-read-only reviewers, each assigned a QA lens (see
 * lenses.js), all looking at the same diff — uncommitted changes by default,
 * or everything since `baseCommit` when given (reviewing a whole branch/PR
 * rather than just what's currently uncommitted). When the diff is too large
 * (~100k+ tokens) to hand every participant in full, participants instead
 * each review a distinct subset of the changed files. Confidence-ranked,
 * adversarially-verified reconciliation (see reconcileRecursive) replaces a
 * single naive synthesis pass.
 */
export async function runAudit({
  count,
  replicas,
  lenses: lensSelection,
  dir,
  model,
  variant,
  tier,
  waitMs,
  focus,
  depth = 1,
  baseCommit,
  contextFile,
  knownFindings,
  verbose = false,
}) {
  const { diff, status, files, mode, base } = getDiff({ dir, baseCommit });
  if (!diff.trim() && !status.trim()) {
    return { participants: [], reconciliation: null, message: "No changes found — nothing to audit.", diff: "", status: "" };
  }

  const { lenses, unknown } = resolveLenses(lensSelection);
  const projectContext = loadProjectContext({ dir, contextFile });
  const approxTokens = Math.ceil(diff.length / 4);
  const scopeLabel =
    mode === "commit" ? `the changes from commit ${base} through HEAD in this git repository` : `the UNCOMMITTED changes (working tree vs HEAD) in this git repository`;

  // Oversized diffs can't be inlined for every participant. Note that this
  // does NOT partition files across participants any more: under the replica
  // model, reviewers sharing a lens must see identical content or their
  // agreement stops meaning anything. Instead every participant gets the same
  // bounded prefix plus the paths of what was left out — they have read access
  // and are told to open those themselves. For a genuinely repo-scale review,
  // opencode_sweep segments properly instead of truncating.
  let contentSection;
  let truncatedFiles = [];
  if (approxTokens > LARGE_DIFF_TOKEN_THRESHOLD && files.length > 1) {
    const budgetChars = LARGE_DIFF_TOKEN_THRESHOLD * 4;
    const included = [];
    let used = 0;
    for (const f of files) {
      const d = getDiffForFiles({ dir, baseCommit, files: [f] });
      if (used + d.length > budgetChars && included.length) break;
      included.push({ file: f, diff: d });
      used += d.length;
    }
    truncatedFiles = files.filter((f) => !included.some((i) => i.file === f));
    contentSection =
      `This change is large (~${approxTokens} tokens across ${files.length} files) — too big to inline in full.\n\n` +
      `\`git status --porcelain\`:\n${status || "(n/a — commit-range mode)"}\n\n` +
      `Diffs for the first ${included.length} changed file(s):\n${included.map((i) => i.diff).join("\n")}\n\n` +
      `${truncatedFiles.length ? `NOT inlined (open them yourself with your read tool if your lens needs them):\n${truncatedFiles.map((f) => `- ${f}`).join("\n")}` : ""}`;
  } else {
    contentSection = `\`git status --porcelain\`:\n${status || "(n/a — commit-range mode)"}\n\n\`git diff\`:\n${diff}`;
  }

  const { participants, reconciliation, plan } = await runLensSwarm({
    scopeLabel,
    contentSection,
    contentSummaryForAggregator:
      approxTokens > LARGE_DIFF_TOKEN_THRESHOLD
        ? `The reviewed change spans ${files.length} files (~${approxTokens} tokens) and was too large to inline here in full.`
        : `\`git diff\` under review:\n${diff}`,
    lenses,
    replicas,
    count,
    depth,
    dir,
    model,
    variant,
    tier,
    waitMs,
    focus,
    projectContext,
    knownFindings,
    titlePrefix: "mcp-audit",
    emitFindingsBlock: true,
  });

  return {
    participantCount: participants.length,
    lensesUsed: lenses.map((l) => l.key),
    unknownLenses: unknown,
    replicas: plan.replicas,
    planNotes: plan.notes,
    projectContextFile: projectContext?.path ?? null,
    participants: participants.map((p) => ({ index: p.index, lens: p.lens, ...trimJob(p, { keepText: verbose }) })),
    reconciliation,
    diffStat: status,
    approxDiffTokens: approxTokens,
    truncatedFiles,
    mode,
    baseCommit: base,
    filesReviewed: files,
  };
}

/** Exposed for sweep.js — one segment of a whole-project sweep is just a lens swarm over file contents. */
export { runLensSwarm };

/**
 * `investigate`: same fan-out/reconcile shape as audit, but driven by an
 * arbitrary caller-supplied prompt instead of a git diff. Each participant
 * gets a light diversifier nudge (since N identical prompts to the same
 * deterministic model would otherwise just duplicate each other) instead of
 * a fixed lens list, since the question itself is open-ended.
 */
export async function runInvestigate({ prompt, count, dir, model, variant, tier, waitMs, depth = 1, verbose = false }) {
  const n = clampCount(count, defaultWidth({ model, tier }, 16, 5));
  const buildPrompt = (i, total) =>
    `${prompt}\n\n---\nYou are investigator #${i + 1} of ${total} looking into this independently. ` +
    `If there's more than one plausible angle/approach, prefer one the others are less likely to have picked, ` +
    `so the group covers more ground together. You may use read/grep/glob/list/webfetch/websearch — you cannot ` +
    `edit anything (read-only). Report your findings plainly.`;

  const participants = await runReadOnlyBatch({
    count: n,
    buildPrompt,
    dir,
    model,
    variant,
    tier,
    waitMs,
    titlePrefix: "mcp-investigate",
  });

  const context = `${n} independent read-only investigators looked into the question: "${prompt}"`;

  const reconciliation = await reconcileRecursive({ participants, context, depth, count: n, dir, model, variant, tier, waitMs });
  const participantsForReturn = participants.map((p) => ({ index: p.index, ...trimJob(p, { keepText: verbose }) }));

  return { prompt, participantCount: n, participants: participantsForReturn, reconciliation };
}

/**
 * `goal`: SEQUENTIAL passes (never parallel — these agents actually edit
 * code, and running them concurrently in the same working tree would corrupt
 * each other's changes; a prior worktree-tournament design tried parallel
 * independent attempts + a judge panel, but real testing showed the judge
 * panel — same weak model — rejecting genuinely correct candidates, so it
 * was reverted). Each pass after the first continues the previous pass's own
 * opencode session, so it's iterative refinement toward the goal.
 *
 * After EVERY pass, real lint/test commands run (mechanical ground truth,
 * not another LLM opinion) and their actual pass/fail output is attached to
 * the NEXT pass's prompt — a weak model trusting only its own self-report
 * ("done!") is unreliable; a weak model reacting to a real exit code and
 * real stderr is much less so. Commands default to `npm run lint`/`npm test`
 * when `dir`'s package.json declares those scripts; pass `lintCommand`/
 * `testCommand` explicitly to override (or `null` to force-disable one).
 *
 * Only the final verifier is read-only — the working passes are not, that's
 * the whole point of "resolver la tarea".
 */
export async function runGoal({ goal, dir, passes, lintCommand, testCommand, checkTimeoutMs, model, variant, tier, waitMs, agent, verbose = false }) {
  const n = clampCount(passes, 3);
  const resolved = resolveModel({ model, variant, tier });
  const detected = detectChecks(dir);
  const effectiveLint = lintCommand !== undefined ? lintCommand : detected.lintCommand;
  const effectiveTest = testCommand !== undefined ? testCommand : detected.testCommand;
  const timeoutMs = Number.isFinite(Number(checkTimeoutMs)) && Number(checkTimeoutMs) > 0 ? Number(checkTimeoutMs) : 180000;

  const results = [];
  let sessionId;
  let lastChecksText = null;

  for (let i = 0; i < n; i++) {
    let prompt =
      i === 0
        ? goal
        : `Continuing toward this goal (pass ${i + 1} of ${n}):\n${goal}\n\n` +
          `This is a continuation of your own previous work in this session — don't repeat finished work or ` +
          `re-read files you already read unless you need to double check something specific. If the goal is ` +
          `already fully met, say so plainly instead of inventing more changes.`;
    if (lastChecksText) {
      prompt +=
        `\n\nHere is the ACTUAL lint/test output from your previous pass — this is ground truth, not your own ` +
        `self-report. Fix anything shown as failing before doing anything else:\n\n${lastChecksText}`;
    }

    const jobId = startJob({
      prompt,
      model: resolved.model,
      variant: resolved.variant,
      agent,
      dir,
      sessionId,
      title: `mcp-goal-pass-${i + 1}-of-${n}`,
      auto: true,
    });
    await waitForJob(jobId, waitMs);
    const summary = jobSummary(getJob(jobId));
    sessionId = summary.sessionId ?? sessionId;

    const checks = [runCheck(dir, effectiveLint, "lint", timeoutMs), runCheck(dir, effectiveTest, "test", timeoutMs)].filter(Boolean);
    lastChecksText = formatChecksForPrompt(checks);

    results.push({ pass: i + 1, ...summary, checks });
  }

  const verification = await aggregate({
    instructions:
      `A task was attempted across ${n} sequential passes (each continuing the previous pass's session, working ` +
      `toward this goal):\n"${goal}"\n\n` +
      `Below is each pass's own report of what it did, plus the ACTUAL lint/test output captured right after that ` +
      `pass finished (ground truth, not self-reported). Inspect the repository's CURRENT state yourself (read-only) ` +
      `to verify what's actually true on disk — don't just trust the passes' self-reports. Return one consolidated ` +
      `report: was the goal actually met, what changed, any concerns/regressions, anything left undone, and whether ` +
      `lint/tests are passing now.`,
    sources: results.map((r) => ({
      label: `Pass ${r.pass}`,
      text: `${r.text}${r.checks.length ? `\n\n[Lint/test after this pass]\n${formatChecksForPrompt(r.checks)}` : ""}`,
      status: r.status,
      errorMessage: r.errorMessage,
    })),
    dir,
    model,
    variant,
    tier,
    waitMs,
    title: "mcp-goal-verify",
  });

  const passesForReturn = results.map((r) => ({ pass: r.pass, ...trimJob(r, { keepText: verbose }), checks: r.checks }));

  return {
    goal,
    passCount: n,
    passes: passesForReturn,
    sessionId,
    checksUsed: { lintCommand: effectiveLint, testCommand: effectiveTest },
    verification: trimJob(verification, { keepText: true }),
  };
}

/**
 * `job`: runs `goal` through sequential passes (edit-allowed, with lint/test
 * feedback between passes), then feeds the resulting uncommitted diff
 * straight into an adversarial QA audit. Returns both results verbatim — NO
 * interpretation, NO auto-trigger of fix passes. It is the CALLER's job to
 * decide what (if anything) to do with the QA findings (fix them, ignore
 * them, ask the user).
 */
export async function runJob({ goal, dir, passes, lintCommand, testCommand, checkTimeoutMs, qaCount, qaDepth = 1, model, variant, tier, waitMs, agent, verbose = false }) {
  const effectiveQaCount = qaCount ?? defaultWidth({ model, tier }, 16, 8);
  const goalResult = await runGoal({ goal, passes, lintCommand, testCommand, checkTimeoutMs, dir, model, variant, tier, waitMs, agent, verbose });
  const qa = await runAudit({ count: effectiveQaCount, depth: qaDepth, dir, model, variant, tier, waitMs, verbose });
  return { goal, goalResult, qa };
}
