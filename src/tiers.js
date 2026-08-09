import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { blockKey } from "./rank.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = path.join(__dirname, "..", "tiers.generated.json");
const BLOCKLIST_PATH = path.join(__dirname, "..", "blocklist.generated.json");

export const TIER_NAMES = ["low", "mid", "high", "max"];

/**
 * Bootstrap default, used until `opencode_refresh_tiers` has run at least
 * once (or if tiers.generated.json is ever missing/corrupt). Hand-picked
 * 2026-08-02, before the arena-score cross-reference existed — kept only as
 * a safety net, not meant to be "the" ranking.
 */
const BOOTSTRAP_TIERS = {
  low: { model: "opencode/big-pickle", variant: null, label: "low — bootstrap default (free, OpenCode Zen)" },
  mid: { model: "opencode-go/glm-5.2", variant: null, label: "mid — bootstrap default" },
  high: { model: "opencode-go/kimi-k3", variant: null, label: "high — bootstrap default" },
  max: { model: "opencode-go/kimi-k3", variant: "max", label: "max — bootstrap default" },
};

export const DEFAULT_TIER = "low";

function loadGenerated() {
  try {
    const raw = readFileSync(GENERATED_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Current tier map: generated (from opencode_refresh_tiers) if present, else the bootstrap default. */
export function getTierMap() {
  const generated = loadGenerated();
  return generated?.tiers ?? BOOTSTRAP_TIERS;
}

/** Metadata about the current tier map's provenance, for transparency in tool responses. */
export function getTierMapMeta() {
  const generated = loadGenerated();
  return {
    source: generated ? "generated" : "bootstrap-default",
    computedAt: generated?.computedAt ?? null,
    unmatched: generated?.unmatched ?? null,
    blocked: generated?.blocked ?? null,
  };
}

export function saveTierMap({ tiers, bands, candidates, unmatched, blocked, computedAt }) {
  writeFileSync(GENERATED_PATH, JSON.stringify({ tiers, bands, candidates, unmatched, blocked, computedAt }, null, 2));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the tier map is missing or older than maxAgeMs (default 1 day).
 * The bootstrap default (no tiers.generated.json yet) counts as stale too,
 * so a fresh install self-refreshes on its first job instead of running
 * hand-picked guesses indefinitely.
 */
export function isStale(maxAgeMs = ONE_DAY_MS) {
  const meta = getTierMapMeta();
  if (!meta.computedAt) return true;
  return Date.now() - meta.computedAt > maxAgeMs;
}

// Exponential backoff, not a flat block: a single transient blip (a provider
// hiccup lasting seconds/minutes) should only cost a few minutes of routing
// around it, not a full day — observed 2026-08-08, a brief deepseek-v4-flash
// outage kept low/mid/high on the pricier gpt-5.6-luna for hours until
// manually unblocked, visibly spiking that day's spend. Only a model that
// keeps failing on repeated real attempts escalates toward the old 24h
// ceiling; failCount resets to 0 the moment a real job on it succeeds
// (see recordSuccess).
const BACKOFF_SCHEDULE_MS = [
  5 * 60 * 1000, // 1st failure: 5 min
  30 * 60 * 1000, // 2nd: 30 min
  2 * 60 * 60 * 1000, // 3rd: 2h
  8 * 60 * 60 * 1000, // 4th: 8h
  ONE_DAY_MS, // 5th+: 24h (same ceiling as before)
];

function loadBlocklistRaw() {
  if (!existsSync(BLOCKLIST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveBlocklistRaw(entries) {
  writeFileSync(BLOCKLIST_PATH, JSON.stringify(entries, null, 2));
}

function ttlFor(failCount) {
  return BACKOFF_SCHEDULE_MS[Math.min(failCount - 1, BACKOFF_SCHEDULE_MS.length - 1)];
}

/** Non-expired blocklist entries as a Set of "model|variant" keys, for rank.js's computeTierMap. */
export function getBlocklist() {
  const entries = loadBlocklistRaw();
  const now = Date.now();
  const live = new Set();
  for (const [key, entry] of Object.entries(entries)) {
    const ttlMs = entry.ttlMs ?? ttlFor(entry.failCount ?? 1);
    if (now - entry.blockedAt <= ttlMs) live.add(key);
  }
  return live;
}

/**
 * Record a confirmed failure (real error, not just a slow response) so this
 * model+variant is skipped by future tier resolutions. Each consecutive
 * failure (i.e. it's STILL broken the next time something actually tried it,
 * since a live block would have prevented an earlier retry) escalates to the
 * next step of BACKOFF_SCHEDULE_MS instead of jumping straight to a long
 * block — see the schedule's comment for why.
 */
export function blockModel(model, variant, reason) {
  const entries = loadBlocklistRaw();
  const key = blockKey(model, variant);
  const failCount = (entries[key]?.failCount ?? 0) + 1;
  const ttlMs = ttlFor(failCount);
  entries[key] = { model, variant: variant ?? null, blockedAt: Date.now(), reason, failCount, ttlMs };
  saveBlocklistRaw(entries);
}

/**
 * A real job on this model+variant succeeded — clear any blocklist history
 * for it (not just the live block, the failCount too) so a future isolated
 * failure starts the backoff over at 5 min instead of escalating from
 * wherever a past, now-resolved incident left off. Returns true if there was
 * anything to clear (used to decide whether a tier recompute is worth doing).
 */
export function recordSuccess(model, variant) {
  const entries = loadBlocklistRaw();
  const key = blockKey(model, variant);
  if (!(key in entries)) return false;
  delete entries[key];
  saveBlocklistRaw(entries);
  return true;
}

/** Manual override — e.g. after re-enabling a model in the OpenCode dashboard, don't wait out the TTL. */
export function unblockModel(model, variant) {
  const entries = loadBlocklistRaw();
  const key = blockKey(model, variant);
  const existed = key in entries;
  delete entries[key];
  saveBlocklistRaw(entries);
  return existed;
}

export function listBlocked() {
  const entries = loadBlocklistRaw();
  const now = Date.now();
  return Object.values(entries).map((e) => {
    const ttlMs = e.ttlMs ?? ttlFor(e.failCount ?? 1);
    return { ...e, ttlMs, expired: now - e.blockedAt > ttlMs, remainingMs: Math.max(0, ttlMs - (now - e.blockedAt)) };
  });
}

/**
 * Set OPENCODE_MCP_PIN_MODEL (+ optional OPENCODE_MCP_PIN_VARIANT) when
 * registering this server (`claude mcp add opencode --env
 * OPENCODE_MCP_PIN_MODEL=opencode-go/deepseek-v4-flash -- ...`) to force
 * EVERY tier resolution in that session to one fixed model — bypasses
 * ranking, cost pools, and the failure blocklist entirely. Env vars are
 * fixed for a process's whole lifetime, and one opencode-mcp process = one
 * Claude Code session, so this is literally "always this model, this
 * session." Explicit `model` params on individual calls still take
 * precedence over the pin, same as they do over `tier`.
 */
export function pinnedModel() {
  const model = process.env.OPENCODE_MCP_PIN_MODEL;
  if (!model) return null;
  return { model, variant: process.env.OPENCODE_MCP_PIN_VARIANT || null };
}

/**
 * Resolve a `{ model, tier }` request to `{ model, variant, band }`. `band`
 * is the full ordered fallback list for a `tier` request (winner first, then
 * next-best by score) with any live-blocked model+variant filtered out —
 * filtered here, not just at the last full refresh, so a failure recorded
 * seconds ago already affects the very next call, not just the next daily
 * recompute. Explicit `model` requests have no fallback (band is just
 * itself); the caller chose it on purpose.
 */
export function resolveModel({ model, tier }) {
  if (model) return { model, variant: null, band: [{ model, variant: null }] };

  const pinned = pinnedModel();
  if (pinned) return { ...pinned, band: [pinned] };

  const tierName = tier ?? DEFAULT_TIER;
  if (!TIER_NAMES.includes(tierName)) {
    throw new Error(`Unknown tier "${tier}". Use one of: ${TIER_NAMES.join(", ")}`);
  }

  const generated = loadGenerated();
  const blocked = getBlocklist();
  const rawBand = generated?.bands?.[tierName];
  const band = (rawBand && rawBand.length > 0 ? rawBand : [getTierMap()[tierName]])
    .filter(Boolean)
    .filter((c) => !blocked.has(blockKey(c.model, c.variant)));

  if (band.length === 0) {
    throw new Error(`Every candidate for tier "${tierName}" is currently blocked. Run opencode_refresh_tiers or opencode_unblock_model.`);
  }

  return { model: band[0].model, variant: band[0].variant ?? null, band };
}
