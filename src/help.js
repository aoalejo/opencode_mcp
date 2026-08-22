import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// README.md lives at the repo root; this file lives in src/, one level down.
const README_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md");

function readReadme() {
  return readFileSync(README_PATH, "utf8");
}

/**
 * Split the README into sections by `##`/`###` heading. Each section's
 * content runs up to the next heading of the SAME OR SHALLOWER level, so a
 * `##` section's content includes its `###` subsections, while a `###`
 * subsection's own content stops at the next `###` or `##`.
 */
function parseSections(markdown) {
  const lines = markdown.split("\n");
  const headingRe = /^(#{2,3})\s+(.*)$/;
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(headingRe);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), lineIndex: i });
  });

  return headings.map((h, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].lineIndex;
        break;
      }
    }
    return { level: h.level, title: h.title, content: lines.slice(h.lineIndex, end).join("\n").trim() };
  });
}

/**
 * Strip markdown noise (code ticks, file-path parentheticals) from text for
 * looser matching. Only parentheticals that LOOK like a file-path/module
 * reference are dropped (e.g. "(`src/tiers.js`)") — a parenthetical carrying
 * a real search term, like a heading titled "... (tree reduction,
 * `groupSize`)", must survive, or exactly that term becomes unfindable.
 */
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\(([^)]*)\)/g, (whole, inner) => (/[./]/.test(inner) ? " " : ` ${inner} `))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words too generic to carry any matching signal — without this, a query
// like "how does the tournament thing work" spuriously matches whatever
// section happens to contain "the" in its title.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "how", "does", "do", "what", "why", "work", "works", "thing", "this",
  "that", "with", "about", "explain", "tell", "me", "can", "you",
]);
function significantWords(text) {
  return [...new Set(normalize(text).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}
function wordMatches(a, b) {
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Table of contents: every heading with its level and a one-line teaser
 * (the first non-empty line of body text under it, if any) — enough for a
 * caller to pick a section without paying for the whole document.
 */
export function tableOfContents() {
  const sections = parseSections(readReadme());
  return sections.map((s) => {
    const bodyLines = s.content.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    const teaser = bodyLines.find((l) => !l.startsWith("#")) ?? "";
    return { level: s.level, title: s.title, teaser: teaser.length > 140 ? `${teaser.slice(0, 140)}…` : teaser };
  });
}

/**
 * Look up one section by title, tolerant of case/backticks/partial match.
 * Tries exact normalized match first, then substring match either
 * direction — a caller asking for "sweep" should find "`opencode_sweep` —
 * auditing a whole codebase" without needing the exact heading text.
 */
export function findSection(query) {
  const sections = parseSections(readReadme());
  const q = normalize(query);
  if (!q) return { match: null, suggestions: sections.map((s) => s.title) };

  const exact = sections.find((s) => normalize(s.title) === q);
  if (exact) return { match: exact, suggestions: [] };

  const contains = sections.filter((s) => normalize(s.title).includes(q) || q.includes(normalize(s.title)));
  if (contains.length === 1) return { match: contains[0], suggestions: [] };
  if (contains.length > 1) return { match: null, suggestions: contains.map((s) => s.title) };

  // Fall back to a word-overlap score against BOTH title and body — title
  // hits count for more, since a query naming a concept that's merely
  // mentioned in ten unrelated sections' prose shouldn't beat the one
  // section actually about it. Prefix match rather than exact equality
  // ("lens" vs "lenses" are the same word here), and stopwords are excluded
  // so generic phrasing ("how does X work") doesn't spuriously match
  // whatever section happens to contain "the".
  const qWords = significantWords(query);
  if (!qWords.length) return { match: null, suggestions: sections.map((s) => s.title) };

  const TITLE_WEIGHT = 3;
  const scored = sections
    .map((s) => {
      const titleWords = significantWords(s.title);
      const bodyWords = significantWords(s.content);
      const score = qWords.reduce((sum, qw) => {
        if (titleWords.some((w) => wordMatches(qw, w))) return sum + TITLE_WEIGHT;
        if (bodyWords.some((w) => wordMatches(qw, w))) return sum + 1;
        return sum;
      }, 0);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const uniqueBest = scored.length && (scored.length === 1 || scored[0].score > scored[1].score);
  if (uniqueBest) return { match: scored[0].s, suggestions: [] };
  return { match: null, suggestions: scored.length ? scored.slice(0, 5).map((x) => x.s.title) : sections.map((s) => s.title) };
}

export function fullReadme() {
  return readReadme();
}
