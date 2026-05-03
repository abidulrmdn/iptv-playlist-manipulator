# MVP limits and cost controls

These limits match the **IPTV Middleware MVP** product requirement: *hard caps so baseline spend stays negligible; enforce in code and monitor with GCP budget alerts* (see [README](../README.md) and [PRODUCTION.md](./PRODUCTION.md)).

| Constant | Value | Purpose |
|----------|-------|---------|
| `FETCH_M3U_TIMEOUT_MS` | 240,000 ms (4 min) | Per-source upstream HTTP GET (`refresh.ts`) |
| `MAX_SOURCES_PER_USER` | 12 | Firestore + refresh fan-out |
| `MAX_PLAYLISTS_PER_USER` | 15 | Per-user playlist count |
| `MAX_CHANNELS_PER_PLAYLIST` | 500,000 | Parse memory / job time cap for one merged playlist (also the default when `maxChannelsToLoad` is unset on the playlist doc) |
| `MAX_M3U_BYTES` | 70 MiB | Single upstream or output body |
| `MAX_SOURCE_URL_LENGTH` | 4,096 | Source URL field |
| `MAX_XTREAM_BASE_URL_LENGTH` | 512 | Xtream panel base URL (http(s) + host + optional port) |
| `MAX_XTREAM_USERNAME_LENGTH` | 256 | Xtream username |
| `MAX_XTREAM_PASSWORD_LENGTH` | 256 | Xtream password |
| `XTREAM_HTTP_TIMEOUT_MS` | 120,000 ms | Per `player_api.php` request in `xtream.ts` |
| `XTREAM_MAX_API_RESPONSE_BYTES` | 70 MiB | Max JSON body per Xtream API response |
| `XTREAM_MAX_CATEGORY_REQUESTS` | 4,000 | Max per-category stream fetches per phase (live, then VOD); stops earlier at the channel cap |
| `XTREAM_PAGE_SIZE` | 2,000 | Full-size first page triggers `limit`/`offset` follow-ups |
| `XTREAM_MAX_STREAM_PAGES_PER_CATEGORY` | 40 | Max paginated stream pages per category |
| `XTREAM_REQUEST_GAP_MS` | 120 ms | Pause between Xtream stream pages and category fetches |
| `REFRESH_PROGRESS_MIN_MS` | 2,000 ms | Min interval between Firestore `refreshProgress` field updates during refresh |
| `MAX_LABEL_LENGTH` | 120 | Source label |
| `MAX_PLAYLIST_NAME_LENGTH` | 80 | Playlist name |
| `TMDB_CONCURRENCY` | 4 | Parallel TMDB HTTP calls per refresh |
| `SNAPSHOTS_RETAINED` | 3 | Rolling `playlist.snapshot-{n}.m3u` backups before each new write |
| `MAX_EDITOR_PAGE_SIZE` | 6,000 | Callable `getPlaylistEditorData` page size |
| `MAX_EDITOR_SEARCH_CHARS` | 200 | Max length of `search` argument on `getPlaylistEditorData` |
| `EDITOR_HYDRATION_CHUNK_ROWS` | 10,000 | Rows per JSON part file under `editor-cache/{filterKey}/` in Storage |
| `EDITOR_HYDRATION_TICK_MAX_FILTERED` | 18,000 | Max filtered channels processed per `editorHydrationTick` invocation |
| `EDITOR_HYDRATION_PROGRESS_MIN_MS` | 1,800 | Min interval between Firestore `editorHydration` progress writes during a tick |

## Runtime (refresh)

- **Callable `refreshPlaylist`:** Gen2 — **540s** timeout, **1 GiB** memory (`functions/src/index.ts`).
- **Scheduled batch:** at most **15** playlists per scheduler run (`limit(15)` query).
- **Manual refresh:** same `runPlaylistRefresh` path as scheduled.
- **Upstream fetch:** retries on transient HTTP/network errors; alternate **browser-like User-Agent** if the first profile fails; response must look like **M3U** (`#EXTM3U`), not HTML (captures wrong URLs / captive portals). Non-standard HTTP status codes are accepted **only if** the body still validates as M3U (some IPTV panels use custom codes such as 884 with a valid playlist).
- **Xtream Codes:** `player_api.php` is used to pull categories and streams; the Functions build an **M3U** in memory (same merge/rules path as URL sources). Live TV is fetched first (bulk `get_live_streams` when the panel returns a list, else **every** live category until the channel cap or `XTREAM_MAX_CATEGORY_REQUESTS`). If a single response contains exactly `XTREAM_PAGE_SIZE` streams, additional pages are requested with `offset`/`limit` until a short or duplicate page. **VOD** uses the same category + paging pattern. **Series** are not expanded (different API shape).
- **Refresh progress:** While `runPlaylistRefresh` runs, the playlist document may include ephemeral `refreshProgress` (`phase`, `channelsSoFar`, `sourcesDone` / `sourcesTotal`, optional `detail`). The web app listens over Firestore for live status; the field is removed on success or failure (throttled by `REFRESH_PROGRESS_MIN_MS`).

## Optional per-playlist cap

- **`maxChannelsToLoad`** (Firestore field on `playlists/{id}`, optional integer `1` … `MAX_CHANNELS_PER_PLAYLIST`): on each refresh, merge stops after this many channel rows across sources in `sourceIds` order (remaining sources are skipped). Omit or delete the field to use the full `MAX_CHANNELS_PER_PLAYLIST` default. Writable only via the `updatePlaylist` callable (not client Firestore writes).

## Enforcement locations

- `functions/src/constants.ts` — canonical `LIMITS` object and `effectiveMaxChannelsForPlaylist()`.
- `functions/src/index.ts` — `countUserSources` / `countUserPlaylists`, URL length, `createPlaylist` source checks.
- `functions/src/refresh.ts` — `assertLimits`, M3U byte cap after merge, upstream `fetchM3u` timeout / retries.
- `functions/src/xtream.ts` — Xtream HTTP caps, category fan-out, generated M3U size, optional `onProgress` for refresh UI.
- `functions/src/index.ts` — clears `refreshProgress` when `refreshPlaylist` fails; scheduler catch path clears it too; `getPlaylistEditorData` search length cap and tab filter; `editorHydrationTick` uses editor hydration caps.
- `functions/src/editorHydration.ts` — `EDITOR_HYDRATION_*` caps for Storage chunking and Firestore progress throttling.

## TMDB

- Optional `TMDB_API_KEY` in `functions/.env`.
- In-process **per-refresh** query dedupe in `enrich.ts` (same cleaned title → one HTTP call).
- Respect TMDB [terms of use](https://developer.themoviedb.org/docs/terms-of-use); attribution comment in generated M3U when enrichment runs.

## Snapshots (Milestone C)

- **Canonical IDs:** `canonical-ids.json` per playlist (diff input).
- **Diff summary:** `diff-summary.json` (counts for UI).
- **Rolling M3U backups:** `playlist.snapshot-1.m3u` … `playlist.snapshot-{N}.m3u` rotated before each successful main `playlist.m3u` write (`SNAPSHOTS_RETAINED`).
