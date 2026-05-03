import { canonicalId, type ChannelEntry } from "./m3u.js";
import { DEFAULT_RULES, LIMITS, type PlaylistRules, type RulePatternTabScope } from "./constants.js";
import { classifyEditorTab } from "./editorTab.js";

const STRING_LIST_KEYS: (keyof PlaylistRules)[] = [
  "includeGroupPatterns",
  "excludeGroupPatterns",
  "includeNamePatterns",
  "excludeNamePatterns",
  "includeUrlPatterns",
  "excludeUrlPatterns",
  "allowNamePatterns",
  "allowUrlPatterns",
  "allowGroupPatterns",
  "groupOrder",
  "channelOrder",
];

const PATTERN_SCOPE_PAIRS: [keyof PlaylistRules, keyof PlaylistRules][] = [
  ["includeGroupPatterns", "includeGroupPatternScopes"],
  ["excludeGroupPatterns", "excludeGroupPatternScopes"],
  ["includeNamePatterns", "includeNamePatternScopes"],
  ["excludeNamePatterns", "excludeNamePatternScopes"],
  ["includeUrlPatterns", "includeUrlPatternScopes"],
  ["excludeUrlPatterns", "excludeUrlPatternScopes"],
  ["allowNamePatterns", "allowNamePatternScopes"],
  ["allowUrlPatterns", "allowUrlPatternScopes"],
  ["allowGroupPatterns", "allowGroupPatternScopes"],
];

function normalizeRulePatternTabScope(x: unknown): RulePatternTabScope {
  if (x === "tv" || x === "movie" || x === "series" || x === "all") return x;
  return "all";
}

function normalizePatternScopes(merged: PlaylistRules): void {
  for (const [patternsKey, scopesKey] of PATTERN_SCOPE_PAIRS) {
    const patterns = merged[patternsKey] as string[];
    const raw = merged[scopesKey];
    const fromDoc = Array.isArray(raw) ? raw.map(normalizeRulePatternTabScope) : [];
    const aligned: RulePatternTabScope[] = [];
    for (let i = 0; i < patterns.length; i++) aligned.push(fromDoc[i] ?? "all");
    (merged as Record<string, unknown>)[scopesKey as string] = aligned;
  }
}

export function mergePlaylistRules(raw: unknown): PlaylistRules {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RULES };
  const merged: PlaylistRules = { ...DEFAULT_RULES, ...(raw as Partial<PlaylistRules>) };

  for (const k of STRING_LIST_KEYS) {
    const v = merged[k];
    if (!Array.isArray(v)) (merged as Record<string, unknown>)[k as string] = [];
    else (merged as Record<string, unknown>)[k as string] = v.filter((x): x is string => typeof x === "string");
  }

  const gr = merged.groupRenames;
  if (!Array.isArray(gr)) merged.groupRenames = [];
  else {
    merged.groupRenames = gr.filter(
      (x): x is { pattern: string; replacement: string } =>
        Boolean(x) &&
        typeof x === "object" &&
        typeof (x as { pattern?: unknown }).pattern === "string" &&
        typeof (x as { replacement?: unknown }).replacement === "string",
    );
  }

  if (merged.dedupeBy !== "url" && merged.dedupeBy !== "name") merged.dedupeBy = "url";
  if (typeof merged.dedupe !== "boolean") merged.dedupe = true;

  if (merged.channelOrder.length > LIMITS.MAX_CHANNEL_ORDER_ENTRIES) {
    merged.channelOrder = merged.channelOrder.slice(0, LIMITS.MAX_CHANNEL_ORDER_ENTRIES);
  }
  normalizePatternScopes(merged);
  return merged;
}

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

function includePassScoped(ch: ChannelEntry, patterns: string[], scopes: RulePatternTabScope[], value: string): boolean {
  const tab = classifyEditorTab(ch);
  const applicable: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const sc = scopes[i] ?? "all";
    if (sc !== "all" && sc !== tab) continue;
    applicable.push(patterns[i]!);
  }
  if (applicable.length === 0) return true;
  return matchesAny(applicable, value);
}

function excludeHitScoped(ch: ChannelEntry, patterns: string[], scopes: RulePatternTabScope[], value: string): boolean {
  const tab = classifyEditorTab(ch);
  for (let i = 0; i < patterns.length; i++) {
    const sc = scopes[i] ?? "all";
    if (sc !== "all" && sc !== tab) continue;
    const r = compileSafe(patterns[i]!);
    if (r && r.test(value)) return true;
  }
  return false;
}

function allowMatchesScoped(ch: ChannelEntry, patterns: string[], scopes: RulePatternTabScope[], value: string): boolean {
  const tab = classifyEditorTab(ch);
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

function sortChannelsByRules(out: ChannelEntry[], rules: PlaylistRules): void {
  const groupRank = new Map<string, number>();
  rules.groupOrder.forEach((g, idx) => groupRank.set(g, idx));
  const chanRank = new Map<string, number>();
  rules.channelOrder.forEach((id, idx) => chanRank.set(id, idx));
  out.sort((a, b) => {
    const ga = a.groupTitle ?? "";
    const gb = b.groupTitle ?? "";
    const ra = groupRank.has(ga) ? groupRank.get(ga)! : 1_000_000;
    const rb = groupRank.has(gb) ? groupRank.get(gb)! : 1_000_000;
    if (ra !== rb) return ra - rb;
    const gcmp = ga.localeCompare(gb);
    if (gcmp !== 0) return gcmp;
    const ida = canonicalId(a);
    const idb = canonicalId(b);
    const oa = chanRank.has(ida) ? chanRank.get(ida)! : 1_000_000;
    const ob = chanRank.has(idb) ? chanRank.get(idb)! : 1_000_000;
    if (oa !== ob) return oa - ob;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Same pipeline as `applyRules`, but also returns channels removed along the way (for editor “hidden by rules” view).
 * `dropped` may list duplicates removed by dedupe; allow-rescue removes matching ids from `dropped`.
 */
export function partitionRulesKeptDropped(
  entries: ChannelEntry[],
  rules: PlaylistRules,
): { kept: ChannelEntry[]; dropped: ChannelEntry[] } {
  const dropped: ChannelEntry[] = [];
  let out = entries.map((e) => ({ ...e }));

  for (let i = 0; i < out.length; i++) {
    const g = applyGroupRenames(rules, out[i].groupTitle);
    out[i] = { ...out[i], groupTitle: g };
  }
  const afterRename = out.map((e) => ({ ...e }));

  if (rules.includeGroupPatterns.length > 0) {
    const scopes = rules.includeGroupPatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (includePassScoped(ch, rules.includeGroupPatterns, scopes, ch.groupTitle ?? "")) next.push(ch);
      else dropped.push({ ...ch });
    }
    out = next;
  }
  {
    const patterns = rules.excludeGroupPatterns;
    const scopes = rules.excludeGroupPatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (excludeHitScoped(ch, patterns, scopes, ch.groupTitle ?? "")) dropped.push({ ...ch });
      else next.push(ch);
    }
    out = next;
  }

  if (rules.includeNamePatterns.length > 0) {
    const scopes = rules.includeNamePatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (includePassScoped(ch, rules.includeNamePatterns, scopes, ch.title)) next.push(ch);
      else dropped.push({ ...ch });
    }
    out = next;
  }
  {
    const patterns = rules.excludeNamePatterns;
    const scopes = rules.excludeNamePatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (excludeHitScoped(ch, patterns, scopes, ch.title)) dropped.push({ ...ch });
      else next.push(ch);
    }
    out = next;
  }

  if (rules.includeUrlPatterns.length > 0) {
    const scopes = rules.includeUrlPatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (includePassScoped(ch, rules.includeUrlPatterns, scopes, ch.url)) next.push(ch);
      else dropped.push({ ...ch });
    }
    out = next;
  }
  {
    const patterns = rules.excludeUrlPatterns;
    const scopes = rules.excludeUrlPatternScopes;
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      if (excludeHitScoped(ch, patterns, scopes, ch.url)) dropped.push({ ...ch });
      else next.push(ch);
    }
    out = next;
  }

  if (rules.dedupe) {
    const seen = new Set<string>();
    const next: ChannelEntry[] = [];
    for (const ch of out) {
      const key = rules.dedupeBy === "name" ? ch.title.trim().toLowerCase() : ch.url.trim();
      if (seen.has(key)) dropped.push({ ...ch });
      else {
        seen.add(key);
        next.push(ch);
      }
    }
    out = next;
  }

  sortChannelsByRules(out, rules);

  const allowN = rules.allowNamePatterns;
  const allowU = rules.allowUrlPatterns;
  const allowG = rules.allowGroupPatterns;
  const allowNS = rules.allowNamePatternScopes;
  const allowUS = rules.allowUrlPatternScopes;
  const allowGS = rules.allowGroupPatternScopes;
  if (allowN.length > 0 || allowU.length > 0 || allowG.length > 0) {
    const keyFn = (ch: ChannelEntry) =>
      rules.dedupeBy === "name" ? ch.title.trim().toLowerCase() : ch.url.trim();
    const inOut = new Set(out.map(keyFn));
    const rescued = afterRename.filter((ch) => {
      if (inOut.has(keyFn(ch))) return false;
      if (allowN.length > 0 && allowMatchesScoped(ch, allowN, allowNS, ch.title)) return true;
      if (allowU.length > 0 && allowMatchesScoped(ch, allowU, allowUS, ch.url)) return true;
      if (allowG.length > 0 && allowMatchesScoped(ch, allowG, allowGS, ch.groupTitle ?? "")) return true;
      return false;
    });
    if (rescued.length > 0) {
      const rescuedIds = new Set(rescued.map((ch) => canonicalId(ch)));
      for (let i = dropped.length - 1; i >= 0; i--) {
        if (rescuedIds.has(canonicalId(dropped[i]!))) dropped.splice(i, 1);
      }
      out = [...out, ...rescued];
      if (rules.dedupe) {
        const seen = new Set<string>();
        const next: ChannelEntry[] = [];
        for (const ch of out) {
          const k = keyFn(ch);
          if (seen.has(k)) dropped.push({ ...ch });
          else {
            seen.add(k);
            next.push(ch);
          }
        }
        out = next;
      }
      sortChannelsByRules(out, rules);
    }
  }

  return { kept: out, dropped };
}

export function applyRules(entries: ChannelEntry[], rules: PlaylistRules): ChannelEntry[] {
  return partitionRulesKeptDropped(entries, rules).kept;
}
