/** Tab scope for a pattern at the same index in the parallel `*PatternScopes` array (`"all"` = every category). */
export type RulePatternTabScope = "all" | "tv" | "movie" | "series";

export type PlaylistRules = {
  dedupe: boolean;
  dedupeBy: "url" | "name";
  includeGroupPatterns: string[];
  /** Same length as `includeGroupPatterns`; defaults to `"all"` when missing in stored rules. */
  includeGroupPatternScopes: RulePatternTabScope[];
  excludeGroupPatterns: string[];
  excludeGroupPatternScopes: RulePatternTabScope[];
  includeNamePatterns: string[];
  includeNamePatternScopes: RulePatternTabScope[];
  excludeNamePatterns: string[];
  excludeNamePatternScopes: RulePatternTabScope[];
  includeUrlPatterns: string[];
  includeUrlPatternScopes: RulePatternTabScope[];
  excludeUrlPatterns: string[];
  excludeUrlPatternScopes: RulePatternTabScope[];
  /** After normal filters, bring matching rows back in (dedupe re-applied). */
  allowNamePatterns: string[];
  allowNamePatternScopes: RulePatternTabScope[];
  allowUrlPatterns: string[];
  allowUrlPatternScopes: RulePatternTabScope[];
  allowGroupPatterns: string[];
  allowGroupPatternScopes: RulePatternTabScope[];
  groupRenames: { pattern: string; replacement: string }[];
  groupOrder: string[];
  /** Channel ids (`canonicalId`) — lower index sorts earlier within the same group after `groupOrder`. */
  channelOrder: string[];
  latestGroupName: string;
  newMarkerPrefix: string;
};

/** Hard limits for cost control (PRD: stay free / minimum cost). */
export const LIMITS = {
  /** Per-source HTTP GET timeout in `refresh.ts` (large public index.m3u files). */
  FETCH_M3U_TIMEOUT_MS: 240_000,
  MAX_SOURCES_PER_USER: 12,
  MAX_PLAYLISTS_PER_USER: 15,
  MAX_CHANNELS_PER_PLAYLIST: 500_000,
  MAX_M3U_BYTES: 70 * 1024 * 1024,
  MAX_SOURCE_URL_LENGTH: 4096,
  /** Xtream panel base URL (scheme + host + optional port only, normalized server-side). */
  MAX_XTREAM_BASE_URL_LENGTH: 512,
  MAX_XTREAM_USERNAME_LENGTH: 256,
  MAX_XTREAM_PASSWORD_LENGTH: 256,
  /** Per `player_api.php` HTTP call (categories / streams). */
  XTREAM_HTTP_TIMEOUT_MS: 120_000,
  /** Max JSON body per Xtream API response (live/VOD list payloads). */
  XTREAM_MAX_API_RESPONSE_BYTES: 70 * 1024 * 1024,
  /**
   * Max per-category `get_*_streams` HTTP calls per refresh phase (live, then VOD).
   * Stops early once `MAX_CHANNELS_PER_PLAYLIST` rows are collected; this is only a safety ceiling.
   */
  XTREAM_MAX_CATEGORY_REQUESTS: 4_000,
  /** When a panel returns exactly this many streams, fetch further pages with `offset` until a short/duplicate page. */
  XTREAM_PAGE_SIZE: 2_000,
  /** Max extra pages per category after the first full-size page (avoids infinite loops if `offset` is ignored). */
  XTREAM_MAX_STREAM_PAGES_PER_CATEGORY: 40,
  /** Pause between Xtream category fetches to reduce rate limits. */
  XTREAM_REQUEST_GAP_MS: 120,
  /** Min interval between Firestore `refreshProgress` writes during a playlist refresh. */
  REFRESH_PROGRESS_MIN_MS: 2_000,
  /** During Xtream catalog build, write a Storage checkpoint every N emitted rows (raw merged prefix). */
  REFRESH_XTREAM_CHECKPOINT_CHANNELS: 10_000,
  /** Max Storage checkpoint writes per playlist refresh (caps cost if a catalog is huge). */
  REFRESH_CHECKPOINT_MAX_STORAGE_WRITES: 40,
  MAX_LABEL_LENGTH: 120,
  MAX_PLAYLIST_NAME_LENGTH: 80,
  /** Max concurrent TMDB lookups per refresh (Milestone B). */
  TMDB_CONCURRENCY: 4,
  SNAPSHOTS_RETAINED: 3,
  /** Max channels returned per getPlaylistEditorData page (UX vs payload size). */
  MAX_EDITOR_PAGE_SIZE: 6_000,
  /** Max characters accepted for `getPlaylistEditorData` substring search (cost / abuse). */
  MAX_EDITOR_SEARCH_CHARS: 200,
  /** Rows per JSON chunk file for editor hydration cache (Storage). */
  EDITOR_HYDRATION_CHUNK_ROWS: 10_000,
  /** Max filtered channels processed per `editorHydrationTick` (wall time + work cap). */
  EDITOR_HYDRATION_TICK_MAX_FILTERED: 18_000,
  /** Min interval between Firestore `editorHydration` progress writes during a tick. */
  EDITOR_HYDRATION_PROGRESS_MIN_MS: 1_800,
  /** Cap stored manual channel ordering (Firestore size / UX). */
  MAX_CHANNEL_ORDER_ENTRIES: 10_000,
} as const;

/** Max merged channel rows for one playlist when Firestore omits `maxChannelsToLoad` or value is invalid. */
export function effectiveMaxChannelsForPlaylist(stored: unknown): number {
  if (stored == null) return LIMITS.MAX_CHANNELS_PER_PLAYLIST;
  const n = typeof stored === "number" ? stored : Math.floor(Number(stored));
  if (!Number.isFinite(n) || n < 1) return LIMITS.MAX_CHANNELS_PER_PLAYLIST;
  return Math.min(LIMITS.MAX_CHANNELS_PER_PLAYLIST, Math.floor(n));
}

export const DEFAULT_RULES: PlaylistRules = {
  dedupe: true,
  dedupeBy: "url",
  includeGroupPatterns: [],
  includeGroupPatternScopes: [],
  excludeGroupPatterns: [],
  excludeGroupPatternScopes: [],
  includeNamePatterns: [],
  includeNamePatternScopes: [],
  excludeNamePatterns: [],
  excludeNamePatternScopes: [],
  includeUrlPatterns: [],
  includeUrlPatternScopes: [],
  excludeUrlPatterns: [],
  excludeUrlPatternScopes: [],
  allowNamePatterns: [],
  allowNamePatternScopes: [],
  allowUrlPatterns: [],
  allowUrlPatternScopes: [],
  allowGroupPatterns: [],
  allowGroupPatternScopes: [],
  groupRenames: [],
  groupOrder: [],
  channelOrder: [],
  latestGroupName: "Latest fetch",
  newMarkerPrefix: "[NEW] ",
};
