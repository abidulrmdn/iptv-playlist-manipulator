/**
 * Client-side preview of `functions/src/rules.ts` → `applyRules` (keep in sync when server rules change).
 * Used only to hide/show rows in the organizer; the rebuilt M3U still comes from the server.
 */
import type { PlaylistRules, RulePatternTabScope } from "../../functions/src/constants";
import type { ChannelEntry } from "../../functions/src/m3u";
import { classifyEditorTab } from "../../functions/src/editorTab";

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
  /** When set, tab-scoped patterns use this tab (organizer row tab from the server). */
  editorTab?: "tv" | "movie" | "series";
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

function previewTab<T extends PreviewChannel>(ch: T): ReturnType<typeof classifyEditorTab> {
  if (ch.editorTab) return ch.editorTab;
  return classifyEditorTab(ch as unknown as ChannelEntry);
}

function includePassScopedPreview<T extends PreviewChannel>(
  ch: T,
  patterns: string[],
  scopes: RulePatternTabScope[],
  value: string,
): boolean {
  const tab = previewTab(ch);
  const applicable: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const sc = scopes[i] ?? "all";
    if (sc !== "all" && sc !== tab) continue;
    applicable.push(patterns[i]!);
  }
  if (applicable.length === 0) return true;
  return matchesAny(applicable, value);
}

function excludeHitScopedPreview<T extends PreviewChannel>(
  ch: T,
  patterns: string[],
  scopes: RulePatternTabScope[],
  value: string,
): boolean {
  const tab = previewTab(ch);
  for (let i = 0; i < patterns.length; i++) {
    const sc = scopes[i] ?? "all";
    if (sc !== "all" && sc !== tab) continue;
    const r = compileSafe(patterns[i]!);
    if (r && r.test(value)) return true;
  }
  return false;
}

function allowMatchesScopedPreview<T extends PreviewChannel>(
  ch: T,
  patterns: string[],
  scopes: RulePatternTabScope[],
  value: string,
): boolean {
  const tab = previewTab(ch);
  for (let i = 0; i < patterns.length; i++) {
    const sc = scopes[i] ?? "all";
    if (sc !== "all" && sc !== tab) continue;
    const r = compileSafe(patterns[i]!);
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

  const allowN = rules.allowNamePatterns;
  const allowU = rules.allowUrlPatterns;
  const allowG = rules.allowGroupPatterns;
  const needsAllowRescue = allowN.length > 0 || allowU.length > 0 || allowG.length > 0;
  /** Post-rename full list before filters — only built when allow-rules may rescue rows. */
  const afterRename = needsAllowRescue ? out.map((e) => ({ ...e })) : [];

  if (rules.includeGroupPatterns.length > 0) {
    const scopes = rules.includeGroupPatternScopes;
    out = out.filter((ch) => includePassScopedPreview(ch, rules.includeGroupPatterns, scopes, ch.groupTitle ?? ""));
  }
  out = out.filter(
    (ch) => !excludeHitScopedPreview(ch, rules.excludeGroupPatterns, rules.excludeGroupPatternScopes, ch.groupTitle ?? ""),
  );

  if (rules.includeNamePatterns.length > 0) {
    const scopes = rules.includeNamePatternScopes;
    out = out.filter((ch) => includePassScopedPreview(ch, rules.includeNamePatterns, scopes, ch.title));
  }
  out = out.filter(
    (ch) => !excludeHitScopedPreview(ch, rules.excludeNamePatterns, rules.excludeNamePatternScopes, ch.title),
  );

  if (rules.includeUrlPatterns.length > 0) {
    const scopes = rules.includeUrlPatternScopes;
    out = out.filter((ch) => includePassScopedPreview(ch, rules.includeUrlPatterns, scopes, ch.url));
  }
  out = out.filter((ch) => !excludeHitScopedPreview(ch, rules.excludeUrlPatterns, rules.excludeUrlPatternScopes, ch.url));

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

  const allowNS = rules.allowNamePatternScopes;
  const allowUS = rules.allowUrlPatternScopes;
  const allowGS = rules.allowGroupPatternScopes;
  if (needsAllowRescue) {
    const keyFn = (ch: T) =>
      rules.dedupeBy === "name" ? ch.title.trim().toLowerCase() : ch.url.trim();
    const inOut = new Set(out.map(keyFn));
    const rescued = afterRename.filter((ch) => {
      if (inOut.has(keyFn(ch))) return false;
      if (allowN.length > 0 && allowMatchesScopedPreview(ch, allowN, allowNS, ch.title)) return true;
      if (allowU.length > 0 && allowMatchesScopedPreview(ch, allowU, allowUS, ch.url)) return true;
      if (allowG.length > 0 && allowMatchesScopedPreview(ch, allowG, allowGS, ch.groupTitle ?? "")) return true;
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
