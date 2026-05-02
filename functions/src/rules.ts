import { canonicalId, type ChannelEntry } from "./m3u.js";
import { DEFAULT_RULES, LIMITS, type PlaylistRules } from "./constants.js";

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

export function applyRules(entries: ChannelEntry[], rules: PlaylistRules): ChannelEntry[] {
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

  sortChannelsByRules(out, rules);

  const allowN = rules.allowNamePatterns;
  const allowU = rules.allowUrlPatterns;
  const allowG = rules.allowGroupPatterns;
  if (allowN.length > 0 || allowU.length > 0 || allowG.length > 0) {
    const keyFn = (ch: ChannelEntry) =>
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
      sortChannelsByRules(out, rules);
    }
  }

  return out;
}
