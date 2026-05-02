/**
 * Client-side preview of `functions/src/rules.ts` → `applyRules` (keep in sync when server rules change).
 * Used only to hide/show rows in the organizer; the rebuilt M3U still comes from the server.
 */
import type { PlaylistRules } from "../../functions/src/constants";

export type PreviewChannel = {
  duration: string;
  title: string;
  url: string;
  attrString: string;
  groupTitle?: string;
  tvgLogo?: string;
  tvgName?: string;
  /** Server channel id (canonical); used with `rules.channelOrder` in the organizer preview. */
  editorId?: string;
};

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

function sortPreviewByRules<T extends PreviewChannel>(out: T[], rules: PlaylistRules): void {
  const groupRank = new Map<string, number>();
  rules.groupOrder.forEach((g, idx) => groupRank.set(g, idx));
  const chanRank = new Map<string, number>();
  (rules.channelOrder ?? []).forEach((id, idx) => chanRank.set(id, idx));
  out.sort((a, b) => {
    const ga = a.groupTitle ?? "";
    const gb = b.groupTitle ?? "";
    const ra = groupRank.has(ga) ? groupRank.get(ga)! : 1_000_000;
    const rb = groupRank.has(gb) ? groupRank.get(gb)! : 1_000_000;
    if (ra !== rb) return ra - rb;
    const gcmp = ga.localeCompare(gb);
    if (gcmp !== 0) return gcmp;
    const ida = (a as PreviewChannel).editorId;
    const idb = (b as PreviewChannel).editorId;
    const oa = ida && chanRank.has(ida) ? chanRank.get(ida)! : 1_000_000;
    const ob = idb && chanRank.has(idb) ? chanRank.get(idb)! : 1_000_000;
    if (oa !== ob) return oa - ob;
    return a.title.localeCompare(b.title);
  });
}

export function applyRulesPreview<T extends PreviewChannel>(entries: T[], rules: PlaylistRules): T[] {
  let out = entries.map((e) => ({ ...e }));

  for (let i = 0; i < out.length; i++) {
    const g = applyGroupRenames(rules, out[i].groupTitle);
    out[i] = { ...out[i], groupTitle: g };
  }
  const afterRename = out.map((e) => ({ ...e }));

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

  sortPreviewByRules(out, rules);

  const allowN = rules.allowNamePatterns;
  const allowU = rules.allowUrlPatterns;
  const allowG = rules.allowGroupPatterns;
  if (allowN.length > 0 || allowU.length > 0 || allowG.length > 0) {
    const keyFn = (ch: T) =>
      rules.dedupeBy === "name" ? ch.title.trim().toLowerCase() : ch.url.trim();
    const inOut = new Set(out.map(keyFn));
    const rescued = afterRename.filter((ch) => {
      if (inOut.has(keyFn(ch))) return false;
      if (allowN.length > 0 && matchesAny(allowN, ch.title)) return true;
      if (allowU.length > 0 && matchesAny(allowU, ch.url)) return true;
      if (allowG.length > 0 && matchesAny(allowG, ch.groupTitle ?? "")) return true;
      return false;
    });
    if (rescued.length > 0) {
      out = [...out, ...rescued];
      if (rules.dedupe) {
        const seen = new Set<string>();
        out = out.filter((ch) => {
          const k = keyFn(ch);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      sortPreviewByRules(out, rules);
    }
  }

  return out;
}
