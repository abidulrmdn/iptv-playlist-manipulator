import type { ChannelEntry } from "./m3u.js";
import { LIMITS } from "./constants.js";

type TmdbMultiResult = {
  results?: Array<{
    id: number;
    media_type?: string;
    name?: string;
    title?: string;
    overview?: string;
  }>;
};

function cleanTitleForSearch(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(4k|uhd|fhd|hd|sd|hdtv|dts|aac|hevc|h265|h264|x264|x265)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function shouldTryEnrich(ch: ChannelEntry): boolean {
  const g = (ch.groupTitle ?? "").toLowerCase();
  return /movie|cinema|vod|series|show|tv/.test(g) || /movie|series/i.test(ch.title);
}

async function fetchTmdb(apiKey: string, query: string): Promise<{ line: string } | null> {
  const u = new URL("https://api.themoviedb.org/3/search/multi");
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("query", query);
  u.searchParams.set("page", "1");
  const res = await fetch(u.toString());
  if (!res.ok) return null;
  const json = (await res.json()) as TmdbMultiResult;
  const hit = json.results?.find((r) => r.media_type === "movie" || r.media_type === "tv");
  if (!hit) return null;
  const name = hit.title ?? hit.name ?? "";
  const ov = (hit.overview ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!name && !ov) return null;
  const kind = hit.media_type === "movie" ? "movie" : "tv";
  const line = [name && `TMDB(${kind}): ${name}`, ov && `— ${ov}`].filter(Boolean).join(" ");
  return { line };
}

/** One in-flight / completed TMDB response per distinct search query per refresh (Milestone B). */
function tmdbPromiseForQuery(
  apiKey: string,
  query: string,
  inflight: Map<string, Promise<{ line: string } | null>>,
): Promise<{ line: string } | null> {
  const key = query.toLowerCase();
  let p = inflight.get(key);
  if (!p) {
    p = fetchTmdb(apiKey, query);
    inflight.set(key, p);
  }
  return p;
}

/** Run TMDB enrichment with bounded concurrency; mutates titles in-place. */
export async function enrichWithTmdb(entries: ChannelEntry[], apiKey: string | undefined): Promise<void> {
  if (!apiKey) return;

  const tmdbInflight = new Map<string, Promise<{ line: string } | null>>();

  const queue = entries
    .map((ch, idx) => ({ ch, idx }))
    .filter(({ ch }) => shouldTryEnrich(ch));
  let cursor = 0;
  const workers = Array.from({ length: LIMITS.TMDB_CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= queue.length) break;
      const { ch, idx } = queue[i];
      const q = cleanTitleForSearch(ch.title);
      if (q.length < 2) continue;
      try {
        const r = await tmdbPromiseForQuery(apiKey, q, tmdbInflight);
        if (r) {
          entries[idx] = { ...ch, title: `${ch.title} (${r.line})` };
        }
      } catch {
        /* skip row */
      }
    }
  });
  await Promise.all(workers);
}
