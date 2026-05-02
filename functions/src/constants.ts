export type PlaylistRules = {
  dedupe: boolean;
  dedupeBy: "url" | "name";
  includeGroupPatterns: string[];
  excludeGroupPatterns: string[];
  includeNamePatterns: string[];
  excludeNamePatterns: string[];
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
  groupRenames: { pattern: string; replacement: string }[];
  groupOrder: string[];
  latestGroupName: string;
  newMarkerPrefix: string;
};

/** Hard limits for cost control (PRD: stay free / minimum cost). */
export const LIMITS = {
  MAX_SOURCES_PER_USER: 12,
  MAX_PLAYLISTS_PER_USER: 15,
  MAX_CHANNELS_PER_PLAYLIST: 35_000,
  MAX_M3U_BYTES: 45 * 1024 * 1024,
  MAX_SOURCE_URL_LENGTH: 4096,
  MAX_LABEL_LENGTH: 120,
  MAX_PLAYLIST_NAME_LENGTH: 80,
  /** Max concurrent TMDB lookups per refresh (Milestone B). */
  TMDB_CONCURRENCY: 4,
  SNAPSHOTS_RETAINED: 3,
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
  groupRenames: [],
  groupOrder: [],
  latestGroupName: "Latest fetch",
  newMarkerPrefix: "[NEW] ",
};
