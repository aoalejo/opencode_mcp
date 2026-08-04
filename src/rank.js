import { listModelsVerbose } from "./catalog.js";
import { fetchWebDevLeaderboard, matchModel } from "./leaderboard.js";

const TIER_NAMES = ["low", "mid", "high", "max"];

/**
 * Cross-reference every opencode-go model's real per-token cost (local,
 * authoritative — see catalog.listModelsVerbose) against its WebDev/code
 * arena score (scraped) to pick the best model per cost tier.
 *
 * Tiers use CUMULATIVE cost pools, not exclusive cost bands: each tier has a
 * cost ceiling (the quartile cutoffs of the full candidate list — low's
 * ceiling is the 25th-percentile cost, mid's the 50th, high's the 75th, max
 * has none), and its winner is the highest-arena-score model anywhere at or
 * under that ceiling — including models cheap enough to belong to a lower
 * tier. This means a cheap model that outperforms every pricier option below
 * its ceiling wins every tier up to that ceiling (e.g. observed 2026-08-03:
 * gpt-5.6-luna, cheap enough for `low`, outscored every model in the `mid`
 * cost bracket, so it legitimately won both — there's no reason to pay more
 * for something worse). Pools are nested by construction (low subset of mid
 * subset of high subset of max), so scores are monotonically non-decreasing
 * from low to max. Whether a tier's final winner also won a cheaper tier
 * (i.e. the collapse actually happened, post live-validation fallback) is
 * flagged by index.js's refreshTierMap, not here — this module only picks
 * candidates per tier.
 *
 * Models with no leaderboard match (e.g. a real distinct SKU the arena
 * hasn't ranked, like qwen3.7-plus as of 2026-08) are excluded from the
 * ranked tiers but reported in `unmatched` for visibility — never silently
 * dropped.
 */
export async function computeTierMap() {
  const [entries, leaderboard] = await Promise.all([
    listModelsVerbose("opencode-go"),
    fetchWebDevLeaderboard(),
  ]);
  if (leaderboard.length === 0) {
    throw new Error("Parsed 0 leaderboard rows — arena.ai markup likely changed; refusing to rank on empty data.");
  }

  const candidates = [];
  const unmatched = [];
  for (const { model, info } of entries) {
    const bareId = model.split("/").slice(1).join("/");
    const match = matchModel(bareId, leaderboard);
    if (!match) {
      unmatched.push(model);
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
      `Only ${candidates.length} models matched the leaderboard — not enough to fill ${TIER_NAMES.length} tiers.`
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
    // Best (highest arena score) first, so a caller can fall through to the
    // next-best eligible candidate if the top pick turns out unreachable
    // (e.g. region-locked — see index.js's opencode_refresh_tiers, which
    // live-validates each pick before saving).
    bands[name] = eligible.sort((a, b) => b.arenaScore - a.arenaScore);
  });

  const tiers = {};
  for (const name of TIER_NAMES) {
    tiers[name] = toTierEntry(name, bands[name][0]);
  }

  return { tiers, bands, candidates, unmatched, computedAt: Date.now() };
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
