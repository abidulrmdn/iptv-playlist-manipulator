---
name: iptv-middleware-mvp
description: Develops and debugs the IPTV Firebase middleware (M3U refresh, rules, Storage blobs, TMDB enrichment, weekly scheduler, diff/NEW). Use when changing functions/src refresh or index callables, LIMITS, enrich.ts, m3u/rules parsers, public M3U serving, or web playlist/source UI tied to those behaviors.
---

# IPTV middleware MVP (project skill)

## Architecture snapshot

- **Callable API + HTTP:** `functions/src/index.ts` — Auth-required callables for sources/playlists/refresh; `publicPlaylist` streams Storage; `scheduledPlaylistRefresh` runs weekly batch.
- **Worker logic:** `functions/src/refresh.ts` — decrypts sources, merges M3Us, applies rules, optional `enrichWithTmdb`, writes `users/{uid}/playlists/{id}/playlist.m3u`, `canonical-ids.json`, `diff-summary.json`, rotates `playlist.snapshot-{n}.m3u`.
- **Parsing / rules:** `functions/src/m3u.ts`, `functions/src/rules.ts` (imports use `.js` extension for ESM emit).
- **Crypto:** `functions/src/crypto.ts` — URLs at rest encrypted; KMS/secret wiring via env as documented in PRODUCTION.

## Checklist when touching refresh or limits

1. Read current `LIMITS` and `DEFAULT_RULES` in `functions/src/constants.ts`.
2. If adding or tightening a limit, update **`docs/LIMITS.md`** in the same change.
3. Ensure scheduler / `nextScheduledRefreshAt` stay aligned (weekly cadence).
4. Run **`npm run build -w functions`**.

## Checklist when touching TMDB

1. Concurrency: `LIMITS.TMDB_CONCURRENCY` — do not unbound parallel `fetch`.
2. Dedupe: reuse existing per-refresh in-flight dedupe in `enrich.ts` for identical queries.
3. Attribution: keep TMDB notice in M3U when enrichment is enabled (terms of use).

## Checklist when touching web

1. Auth: email-link flow; no exposure of full provider URLs from APIs meant for the client.
2. Run **`npm run build -w web`** after UI/state changes.

## Storage paths (mental model)

Prefix: `users/{ownerUid}/playlists/{playlistId}/`

| Object | Role |
|--------|------|
| `playlist.m3u` | Current output for players |
| `playlist.snapshot-1.m3u` … | Rotating backups (`SNAPSHOTS_RETAINED`) |
| `canonical-ids.json` | Stable ids for diff / NEW detection |
| `diff-summary.json` | Counts for UI |

## Out of scope for casual changes

- Xtream **series** expansion (episodes) — live + VOD M3U generation only in `xtream.ts`.
- Per-channel REST PATCH unless explicitly specced; organizer + Firestore rules + callables are the current triage surface.
