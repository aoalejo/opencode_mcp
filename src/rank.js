import { listModelsVerbose } from "./catalog.js";
import { fetchWebDevLeaderboard, matchModel } from "./leaderboard.js";

const TIER_NAMES = ["low", "mid", "high", "max"];

// If a cheaper model scores within this fraction of the best score in its
// pool, prefer it over the top scorer — a 0.5-point edge isn't worth 10x the
// cost. 1% is deliberately conservative (only catches near-ties, not "10
// points cheaper for 50 points less score"); tune here if it's too
// aggressive/timid in practice.
const SCORE_TOLERANCE_PCT = 0.01;

/**
 * Cross-reference every opencode-go model's real per-token cost (local,
 * authoritative — see catalog.listModelsVerbose) against its WebDev/code
 * arena score (scraped) to pick the best model per cost tier.
 *
 * Tiers use CUMULATIVE cost pools, not exclusive cost bands: each tier has a
 * cost ceiling (the quartile cutoffs of the full candidate list — low's
 * ceiling is the 25th-percentile cost, mid's the 50th, high's the 75th, max
 * has none), and its winner is drawn from anywhere at or under that ceiling
 * — including models cheap enough to belong to a lower tier. Pools are
 * nested by construction (low subset of mid subset of high subset of max).
 *
 * Within a tier's pool, the winner is NOT simply the highest score — it's
 * the CHEAPEST model within `SCORE_TOLERANCE_PCT` of the pool's best score
 * (see `pickBest`). A 1676-vs-1668 gap (0.5%) doesn't justify paying 5x more,
 * so the cheaper of the two wins; a 1577-vs-1523 gap (3.5%) is treated as a
 * real quality difference and the higher scorer still wins. This means a
 * cheap model that's merely "good enough" relative to the pool's ceiling can
 * win a tier even without being the outright top scorer.
 *
 * A `blocklist` (Set of "model|variant" strings, variant "" for none) can be
 * passed to exclude models confirmed broken by actual usage (see
 * index.js's recordFailureAndDemote) — excluded entirely, not just
 * deprioritized, since a confirmed-broken pick is never worth offering as a
 * fallback either.
 *
 * Models with no leaderboard match (e.g. a real distinct SKU the arena
 * hasn't ranked, like qwen3.7-plus as of 2026-08) are excluded from the
 * ranked tiers but reported in `unmatched` for visibility — never silently
 * dropped.
 */
export async function computeTierMap({ blocklist = new Set() } = {}) {
  const [entries, leaderboard] = await Promise.all([
    listModelsVerbose("opencode-go"),
    fetchWebDevLeaderboard(),
  ]);
  if (leaderboard.length === 0) {
    throw new Error("Parsed 0 leaderboard rows — arena.ai markup likely changed; refusing to rank on empty data.");
  }

  const candidates = [];
  const unmatched = [];
  const blocked = [];
  for (const { model, info } of entries) {
    const bareId = model.split("/").slice(1).join("/");
    const match = matchModel(bareId, leaderboard);
    if (!match) {
      unmatched.push(model);
      continue;
    }
    if (blocklist.has(blockKey(model, match.variant))) {
      blocked.push(model);
      continue;
    }
    candidates.push({
      model,
      variant: match.variant,
      cost: info.cost,
      contextWindow: info.limit?.context ?? null,
      arenaScore: match.score,
      arenaRank: match.rank,
      arenaSlug: match.slug,
    });
  }

  if (candidates.length < TIER_NAMES.length) {
    throw new Error(
      `Only ${candidates.length} models matched the leaderboard and aren't blocked — not enough to fill ${TIER_NAMES.length} tiers.`
    );
  }

  candidates.sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));

  const bandSize = candidates.length / TIER_NAMES.length;
  // Cost ceiling per tier, from the quartile cutoffs of the FULL candidate
  // list (not the eventual winners) — max has no ceiling (Infinity), so it
  // always has access to every candidate regardless of price.
  const ceilings = TIER_NAMES.map((_, i) => {
    if (i === TIER_NAMES.length - 1) return Infinity;
    const idx = Math.max(0, Math.floor((i + 1) * bandSize) - 1);
    return candidates[idx].cost.input;
  });

  const bands = {};
  TIER_NAMES.forEach((name, i) => {
    const eligible = candidates.filter((c) => (c.cost?.input ?? 0) <= ceilings[i]);
    const winner = pickBest(eligible);
    // Winner first (that's what a caller should try), then the rest by
    // descending score as the fallback order if the winner turns out to be
    // broken — at that point "cheap enough" already failed, so reach for
    // quality on the way back up instead of re-applying the tolerance rule.
    bands[name] = [winner, ...eligible.filter((c) => c !== winner).sort((a, b) => b.arenaScore - a.arenaScore)];
  });

  const tiers = {};
  for (const name of TIER_NAMES) {
    tiers[name] = toTierEntry(name, bands[name][0]);
  }

  return { tiers, bands, candidates, unmatched, blocked, computedAt: Date.now() };
}

/** Cheapest model within SCORE_TOLERANCE_PCT of the pool's best arena score. */
function pickBest(pool) {
  const maxScore = Math.max(...pool.map((c) => c.arenaScore));
  const nearBest = pool.filter((c) => c.arenaScore >= maxScore * (1 - SCORE_TOLERANCE_PCT));
  return nearBest.reduce((a, b) => (b.cost.input < a.cost.input ? b : a));
}

export function blockKey(model, variant) {
  return `${model}|${variant ?? ""}`;
}

export function toTierEntry(name, best) {
  return {
    model: best.model,
    variant: best.variant,
    label: `${name} — ${best.model} (arena #${best.arenaRank}, score ${best.arenaScore}, $${best.cost.input}/$${best.cost.output} per M tokens)`,
    arenaScore: best.arenaScore,
    arenaRank: best.arenaRank,
    cost: best.cost,
  };
}
