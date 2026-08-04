import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = path.join(__dirname, "..", "tiers.generated.json");

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
  };
}

export function saveTierMap({ tiers, candidates, unmatched, computedAt }) {
  writeFileSync(GENERATED_PATH, JSON.stringify({ tiers, candidates, unmatched, computedAt }, null, 2));
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

export function resolveModel({ model, tier }) {
  if (model) return { model, variant: null };
  const map = getTierMap();
  const t = map[tier ?? DEFAULT_TIER];
  if (!t) {
    throw new Error(`Unknown tier "${tier}". Use one of: ${TIER_NAMES.join(", ")}`);
  }
  return { model: t.model, variant: t.variant ?? null };
}
