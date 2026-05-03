/** Mirrors `refreshProgress` on playlist docs during `runPlaylistRefresh`. */
export type PlaylistRefreshProgress = {
  phase: string;
  detail?: string;
  sourcesDone: number;
  sourcesTotal: number;
  channelsSoFar: number;
  /** Xtream row count last written to a Storage checkpoint (if any). */
  checkpointXtreamRows?: number;
};

function num(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") return Number(x);
  return 0;
}

/** One-line status for `aria-live` while a refresh is in progress. */
export function formatRefreshProgressLine(r: PlaylistRefreshProgress): string {
  const ch = num(r.channelsSoFar).toLocaleString();
  const tot = num(r.sourcesTotal);
  const done = num(r.sourcesDone);
  const src = tot > 0 ? ` · Source ${done}/${tot}` : "";
  const ph =
    r.phase === "fetch"
      ? "Fetching"
      : r.phase === "rules"
        ? "Rules"
        : r.phase === "tmdb"
          ? "TMDB"
          : r.phase === "write"
            ? "Saving"
            : r.phase;
  const det = typeof r.detail === "string" && r.detail.trim() ? ` · ${r.detail.trim()}` : "";
  const ck =
    typeof r.checkpointXtreamRows === "number" && Number.isFinite(r.checkpointXtreamRows) && r.checkpointXtreamRows > 0
      ? ` · last checkpoint ${num(r.checkpointXtreamRows).toLocaleString()} Xtream rows`
      : "";
  return `${ph}: ${ch} channels${src}${det}${ck}`;
}
