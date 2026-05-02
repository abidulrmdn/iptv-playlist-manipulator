import type { ChannelEntry } from "./m3u.js";

export type EditorTab = "tv" | "movie" | "series";

const SERIES_TITLE = /(s\d+\s*[xe]\d+|ep\.?\s*\d+|episode\s*\d+|season\s*\d+|complete\s+series|\bseries\b|\bshow\b|\banime\b)/i;
const SERIES_GROUP = /(series|season|shows?|tv\s*series|anime|drama|docu|documentary)/i;
const SERIES_URL = /\/(series|season|show|episode|anime)\//i;
const MOVIE_GROUP = /(movie|cinema|film|vod|movies|4k|box\s*office|hollywood)/i;
const MOVIE_URL = /\/(movie|movies|vod|film|cinema)\//i;

/**
 * Best-effort tab for organizer UI: heuristics on group/title/url, plus TMDB tags when enrichment appended them.
 */
export function classifyEditorTab(ch: ChannelEntry): EditorTab {
  const t = ch.title ?? "";
  const g = (ch.groupTitle ?? "").toLowerCase();
  const u = ch.url.toLowerCase();

  if (/TMDB\(movie\):/i.test(t)) return "movie";
  if (/TMDB\(tv\):/i.test(t)) return "series";

  if (SERIES_TITLE.test(t) || SERIES_GROUP.test(g) || SERIES_URL.test(u)) return "series";
  if (MOVIE_GROUP.test(g) || MOVIE_URL.test(u)) return "movie";
  return "tv";
}
