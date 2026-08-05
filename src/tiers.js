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

// How long a model stays excluded after a confirmed failure before it's
// eligible again — matches the tier refresh cadence so a blocked pick gets
// re-evaluated roughly once a day, same rhythm as the ranking itself. Not
// tied to actually re-testing it: if it's still broken it'll just get
// re-blocked the next time a job resolves to it and fails again.
const BLOCKLIST_TTL_MS = ONE_DAY_MS;

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

/** Non-expired blocklist entries as a Set of "model|variant" keys, for rank.js's computeTierMap. */
export function getBlocklist() {
  const entries = loadBlocklistRaw();
  const now = Date.now();
  const live = new Set();
  for (const [key, entry] of Object.entries(entries)) {
    if (now - entry.blockedAt <= BLOCKLIST_TTL_MS) live.add(key);
  }
  return live;
}

/**
 * Record a confirmed failure (real error, not just a slow response — see
 * index.js's isHardFailure) so this model+variant is skipped by future tier
 * resolutions until BLOCKLIST_TTL_MS passes or it's manually cleared.
 */
export function blockModel(model, variant, reason) {
  const entries = loadBlocklistRaw();
  entries[blockKey(model, variant)] = { model, variant: variant ?? null, blockedAt: Date.now(), reason };
  saveBlocklistRaw(entries);
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
  return Object.values(entries).map((e) => ({ ...e, expired: now - e.blockedAt > BLOCKLIST_TTL_MS }));
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
