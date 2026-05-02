import type { ChannelEntry } from "./m3u.js";
import type { PlaylistRules } from "./constants.js";

function compileSafe(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function matchesAny(patterns: string[], value: string): boolean {
  for (const p of patterns) {
    const r = compileSafe(p);
    if (r && r.test(value)) return true;
  }
  return false;
}

function applyGroupRenames(rules: PlaylistRules, group: string | undefined): string | undefined {
  let g = group ?? "Uncategorized";
  for (const { pattern, replacement } of rules.groupRenames) {
    const r = compileSafe(pattern);
    if (r) g = g.replace(r, replacement);
  }
  return g;
}

export function applyRules(entries: ChannelEntry[], rules: PlaylistRules): ChannelEntry[] {
  let out = entries.map((e) => ({ ...e }));

  for (let i = 0; i < out.length; i++) {
    const g = applyGroupRenames(rules, out[i].groupTitle);
    out[i] = { ...out[i], groupTitle: g };
  }

  if (rules.includeGroupPatterns.length > 0) {
    out = out.filter((ch) => matchesAny(rules.includeGroupPatterns, ch.groupTitle ?? ""));
  }
  out = out.filter((ch) => !matchesAny(rules.excludeGroupPatterns, ch.groupTitle ?? ""));

  if (rules.includeNamePatterns.length > 0) {
    out = out.filter((ch) => matchesAny(rules.includeNamePatterns, ch.title));
  }
  out = out.filter((ch) => !matchesAny(rules.excludeNamePatterns, ch.title));

  if (rules.includeUrlPatterns.length > 0) {
    out = out.filter((ch) => matchesAny(rules.includeUrlPatterns, ch.url));
  }
  out = out.filter((ch) => !matchesAny(rules.excludeUrlPatterns, ch.url));

  if (rules.dedupe) {
    const seen = new Set<string>();
    out = out.filter((ch) => {
      const key = rules.dedupeBy === "name" ? ch.title.trim().toLowerCase() : ch.url.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const groupRank = new Map<string, number>();
  rules.groupOrder.forEach((g, idx) => groupRank.set(g, idx));
  out.sort((a, b) => {
    const ga = a.groupTitle ?? "";
    const gb = b.groupTitle ?? "";
    const ra = groupRank.has(ga) ? groupRank.get(ga)! : 1_000_000;
    const rb = groupRank.has(gb) ? groupRank.get(gb)! : 1_000_000;
    if (ra !== rb) return ra - rb;
    const gcmp = ga.localeCompare(gb);
    if (gcmp !== 0) return gcmp;
    return a.title.localeCompare(b.title);
  });

  return out;
}
