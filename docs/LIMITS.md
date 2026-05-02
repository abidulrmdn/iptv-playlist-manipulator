# MVP limits and cost controls

These limits match the **IPTV Middleware MVP** product requirement: *hard caps so baseline spend stays negligible; enforce in code and monitor with GCP budget alerts* (see [README](../README.md) and [PRODUCTION.md](./PRODUCTION.md)).

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SOURCES_PER_USER` | 12 | Firestore + refresh fan-out |
| `MAX_PLAYLISTS_PER_USER` | 15 | Per-user playlist count |
| `MAX_CHANNELS_PER_PLAYLIST` | 35,000 | Parse memory / job time |
| `MAX_M3U_BYTES` | 45 MiB | Single upstream or output body |
| `MAX_SOURCE_URL_LENGTH` | 4,096 | Source URL field |
| `MAX_LABEL_LENGTH` | 120 | Source label |
| `MAX_PLAYLIST_NAME_LENGTH` | 80 | Playlist name |
| `TMDB_CONCURRENCY` | 4 | Parallel TMDB HTTP calls per refresh |
| `SNAPSHOTS_RETAINED` | 3 | Rolling `playlist.snapshot-{n}.m3u` backups before each new write |
| `MAX_EDITOR_PAGE_SIZE` | 1,500 | Callable `getPlaylistEditorData` page size |

## Runtime (refresh)

- **Callable `refreshPlaylist`:** Gen2 — **540s** timeout, **1 GiB** memory (`functions/src/index.ts`).
- **Scheduled batch:** at most **15** playlists per scheduler run (`limit(15)` query).
- **Manual refresh:** same `runPlaylistRefresh` path as scheduled.

## Enforcement locations

- `functions/src/constants.ts` — canonical `LIMITS` object.
- `functions/src/index.ts` — `countUserSources` / `countUserPlaylists`, URL length, `createPlaylist` source checks.
- `functions/src/refresh.ts` — `assertLimits`, M3U byte cap after merge.

## TMDB

- Optional `TMDB_API_KEY` in `functions/.env`.
- In-process **per-refresh** query dedupe in `enrich.ts` (same cleaned title → one HTTP call).
- Respect TMDB [terms of use](https://developer.themoviedb.org/docs/terms-of-use); attribution comment in generated M3U when enrichment runs.

## Snapshots (Milestone C)

- **Canonical IDs:** `canonical-ids.json` per playlist (diff input).
- **Diff summary:** `diff-summary.json` (counts for UI).
- **Rolling M3U backups:** `playlist.snapshot-1.m3u` … `playlist.snapshot-{N}.m3u` rotated before each successful main `playlist.m3u` write (`SNAPSHOTS_RETAINED`).
