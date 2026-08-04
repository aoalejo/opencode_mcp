const WEBDEV_LEADERBOARD_URL = "https://arena.ai/leaderboard/code/webdev";

// Reasoning-effort suffixes the leaderboard appends to a base model slug
// (e.g. "kimi-k3-max", "deepseek-v4-flash-high"). Stripped one at a time,
// longest-token-sequence first, when a slug doesn't match an opencode model
// id verbatim — see matchModel().
const VARIANT_SUFFIXES = ["xhigh", "high", "max", "minimal", "low", "thinking", "preview"];

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch and parse the WebDev/code leaderboard into {rank, slug, score, votes}
 * rows. The page server-renders a plain HTML <table> (verified by hand,
 * 2026-08-03) — no JS execution needed, but this WILL break if arena.ai
 * changes its markup; that's expected to surface as "0 rows parsed" rather
 * than silently-wrong data (see the sanity check in computeTierMap).
 */
export async function fetchWebDevLeaderboard() {
  const res = await fetch(WEBDEV_LEADERBOARD_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (opencode-mcp tier ranker)" },
  });
  if (!res.ok) {
    throw new Error(`Fetching leaderboard failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const tbodyStart = html.indexOf("<tbody");
  const tbodyEnd = html.indexOf("</tbody>");
  if (tbodyStart === -1 || tbodyEnd === -1) {
    throw new Error("Leaderboard page structure changed: no <tbody> found");
  }
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rowsHtml = tbody.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

  const rows = [];
  for (const rowHtml of rowsHtml) {
    const cells = rowHtml.match(/<td[\s\S]*?<\/td>/g) ?? [];
    if (cells.length < 4) continue;

    const rank = parseInt(stripTags(cells[0]), 10);

    // The exact/untruncated model slug lives in a title="..." attribute
    // inside the model cell (the visible text can be CSS-truncated).
    const titleMatch = cells[2].match(/title="([^"]+)"/);
    const slug = titleMatch ? titleMatch[1] : stripTags(cells[2]).split(" ")[0];

    const scoreText = stripTags(cells[3]);
    const scoreMatch = scoreText.match(/-?\d+(\.\d+)?/);
    const score = scoreMatch ? parseFloat(scoreMatch[0]) : null;

    const votesText = cells[4] ? stripTags(cells[4]).replace(/,/g, "") : "";
    const votes = votesText && /^\d+$/.test(votesText) ? parseInt(votesText, 10) : null;

    if (Number.isFinite(rank) && slug && score != null) {
      rows.push({ rank, slug, score, votes });
    }
  }
  return rows;
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // drop annotations like "(codex-harness)"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isStrippableToken(token) {
  return VARIANT_SUFFIXES.includes(token) || /^\d{6,}$/.test(token); // e.g. dated snapshot "20260517"
}

/**
 * Match an opencode model id (e.g. "kimi-k3", "qwen3.8-max") against
 * leaderboard rows. Tries an exact normalized match first — this correctly
 * handles ids that already end in what LOOKS like a variant suffix but is
 * actually part of the real model name (e.g. "qwen3.8-max" is a distinct
 * real SKU, not "qwen3.8" at variant=max). Only if there's no exact match
 * does it try stripping trailing variant tokens and re-matching, picking
 * whichever stripped-variant row scores highest.
 *
 * Returns the best-scoring matching row plus the variant string to pass to
 * `opencode run --variant` to reproduce that score (null if no stripping
 * was needed, i.e. the leaderboard already ranks the bare model).
 */
export function matchModel(modelId, leaderboardRows) {
  const target = normalize(modelId);
  const byNormalizedSlug = leaderboardRows.map((r) => ({ ...r, _norm: normalize(r.slug) }));

  const exact = byNormalizedSlug.filter((r) => r._norm === target);
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (b.score > a.score ? b : a));
    return { ...best, variant: null };
  }

  // Try stripping known variant suffixes (possibly stacked, e.g. "high-preview").
  let candidates = [];
  for (const r of byNormalizedSlug) {
    const tokens = r._norm.split("-");
    let stripped = [];
    while (tokens.length > 0 && isStrippableToken(tokens[tokens.length - 1])) {
      stripped.unshift(tokens.pop());
    }
    // Only the variant-effort tokens (not stripped date snapshots) go to `--variant`.
    const variantTokens = stripped.filter((t) => VARIANT_SUFFIXES.includes(t));
    if (stripped.length > 0 && tokens.join("-") === target) {
      candidates.push({ ...r, variant: variantTokens.length > 0 ? variantTokens.join("-") : null });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.score > a.score ? b : a));
}
