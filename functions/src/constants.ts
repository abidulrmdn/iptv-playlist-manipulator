export type PlaylistRules = {
  dedupe: boolean;
  dedupeBy: "url" | "name";
  includeGroupPatterns: string[];
  excludeGroupPatterns: string[];
  includeNamePatterns: string[];
  excludeNamePatterns: string[];
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
  /** After normal filters, bring matching rows back in (dedupe re-applied). */
  allowNamePatterns: string[];
  allowUrlPatterns: string[];
  allowGroupPatterns: string[];
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
  MAX_CHANNELS_PER_PLAYLIST: 35_000,
  MAX_M3U_BYTES: 45 * 1024 * 1024,
  MAX_SOURCE_URL_LENGTH: 4096,
  /** Xtream panel base URL (scheme + host + optional port only, normalized server-side). */
  MAX_XTREAM_BASE_URL_LENGTH: 512,
  MAX_XTREAM_USERNAME_LENGTH: 256,
  MAX_XTREAM_PASSWORD_LENGTH: 256,
  /** Per `player_api.php` HTTP call (categories / streams). */
  XTREAM_HTTP_TIMEOUT_MS: 120_000,
  /** Max JSON body per Xtream API response (live/VOD list payloads). */
  XTREAM_MAX_API_RESPONSE_BYTES: 45 * 1024 * 1024,
  /** Max category round-trips when the panel does not return a single combined `get_live_streams` list. */
  XTREAM_MAX_CATEGORY_FETCHES: 250,
  /** Pause between Xtream category fetches to reduce rate limits. */
  XTREAM_REQUEST_GAP_MS: 120,
  MAX_LABEL_LENGTH: 120,
  MAX_PLAYLIST_NAME_LENGTH: 80,
  /** Max concurrent TMDB lookups per refresh (Milestone B). */
  TMDB_CONCURRENCY: 4,
  SNAPSHOTS_RETAINED: 3,
  /** Max channels returned per getPlaylistEditorData page (UX vs payload size). */
  MAX_EDITOR_PAGE_SIZE: 1_500,
  /** Cap stored manual channel ordering (Firestore size / UX). */
  MAX_CHANNEL_ORDER_ENTRIES: 10_000,
} as const;

export const DEFAULT_RULES: PlaylistRules = {
  dedupe: true,
  dedupeBy: "url",
  includeGroupPatterns: [],
  excludeGroupPatterns: [],
  includeNamePatterns: [],
  excludeNamePatterns: [],
  includeUrlPatterns: [],
  excludeUrlPatterns: [],
  allowNamePatterns: [],
  allowUrlPatterns: [],
  allowGroupPatterns: [],
  groupRenames: [],
  groupOrder: [],
  channelOrder: [],
  latestGroupName: "Latest fetch",
  newMarkerPrefix: "[NEW] ",
};
