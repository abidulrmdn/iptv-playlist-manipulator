import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { randomBytes } from "crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { decryptUtf8, encryptUtf8 } from "./crypto.js";
import { DEFAULT_RULES, LIMITS } from "./constants.js";
import { classifyEditorTab } from "./editorTab.js";
import {
  editorHydrationTick as runEditorHydrationTickImpl,
  hashEditorFilterKey,
  tryReadEditorRowsFromCache,
  type EditorHydrationState,
} from "./editorHydration.js";
import { buildExcludeNamePatternsFromTitles } from "./excludeNamePatternChunks.js";
import { canonicalId, parseM3u } from "./m3u.js";
import { mergePlaylistRules } from "./rules.js";
import { runPlaylistRefresh } from "./refresh.js";
import { normalizeXtreamBaseUrl } from "./xtream.js";

for (const p of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "functions", ".env")]) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

initializeApp();
const db = getFirestore();
const bucket = getStorage().bucket(); // Gen2 HTTPS + scheduler (invoker public + IAM binding in predeploy).

// Gen2 = Cloud Run. Callables send a Firebase ID token, not a Google OIDC token; Cloud Run must allow
// unauthenticated invocation at the edge, while requireAuth() / CallableRequest.auth enforce Firebase Auth.
// Global + per-function invoker (some deploy paths only apply per-function IAM).
setGlobalOptions({ region: "us-central1", maxInstances: 5, invoker: "public" });

/** Merge into every HTTPS / scheduled function so Cloud Run grants unauthenticated invoke at the edge. */
const RUN_INVOKER_PUBLIC = { invoker: "public" as const };

/**
 * Secret Manager id (must not match `ENCRYPTION_KEY` in functions/.env — Firebase would reject
 * overlapping plain env + secret on the same Cloud Run revision).
 * Runtime value is read in `crypto.ts` via `process.env.IPTV_ENCRYPTION_KEY`.
 */
const encryptionKeySecret = defineSecret("IPTV_ENCRYPTION_KEY");

function requireAuth(uid: string | undefined): asserts uid is string {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required");
}

/** Avoid aggregation `count()` quirks in some emulator versions. */
async function countUserSources(uid: string): Promise<number> {
  const snap = await db
    .collection("sources")
    .where("ownerUid", "==", uid)
    .limit(LIMITS.MAX_SOURCES_PER_USER + 1)
    .get();
  return snap.size;
}

async function countUserPlaylists(uid: string): Promise<number> {
  const snap = await db
    .collection("playlists")
    .where("ownerUid", "==", uid)
    .limit(LIMITS.MAX_PLAYLISTS_PER_USER + 1)
    .get();
  return snap.size;
}

export const upsertSource = onCall({ ...RUN_INVOKER_PUBLIC, secrets: [encryptionKeySecret] }, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  console.info("[upsertSource] entry", {
    hasIptvKey: Boolean(process.env.IPTV_ENCRYPTION_KEY?.trim()),
    hasEnvKey: Boolean(process.env.ENCRYPTION_KEY?.trim()),
  });
  const label = String(request.data?.label ?? "").slice(0, LIMITS.MAX_LABEL_LENGTH);
  const rawType = String(request.data?.sourceType ?? request.data?.kind ?? "m3u").toLowerCase();
  const sourceType = rawType === "xtream" ? "xtream" : "m3u";

  const encryptPayload = (plain: string, labelErr: string) => {
    try {
      return encryptUtf8(plain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const inEmu = process.env.FUNCTIONS_EMULATOR === "true";
      if (msg.includes("ENCRYPTION_KEY") || msg.includes("IPTV_ENCRYPTION_KEY")) {
        throw new HttpsError(
          "failed-precondition",
          inEmu
            ? "Encryption key is missing or invalid. Set ENCRYPTION_KEY in functions/.env (openssl rand -base64 32), then restart the emulators."
            : "Server encryption is not configured: set Secret IPTV_ENCRYPTION_KEY (same value as ENCRYPTION_KEY in docs) with firebase functions:secrets:set, then redeploy.",
        );
      }
      console.error("upsertSource encrypt error", err);
      throw new HttpsError(
        "failed-precondition",
        inEmu
          ? `Could not encrypt ${labelErr}. Check the Functions emulator logs and ENCRYPTION_KEY in functions/.env.`
          : `Could not encrypt ${labelErr}. Check Cloud Functions logs and the IPTV_ENCRYPTION_KEY secret.`,
      );
    }
  };

  try {
    const id = String(request.data?.id ?? "");
    if (!id) {
      const count = await countUserSources(uid);
      if (count >= LIMITS.MAX_SOURCES_PER_USER) {
        throw new HttpsError("resource-exhausted", "Source limit reached");
      }
    }

    let editSnap: DocumentSnapshot | null = null;
    if (id) {
      const ref = db.collection("sources").doc(id);
      editSnap = await ref.get();
      if (!editSnap.exists || (editSnap.data() as { ownerUid?: string }).ownerUid !== uid) {
        throw new HttpsError("not-found", "Source not found");
      }
    }

    let payload: Record<string, unknown>;

    if (sourceType === "m3u") {
      const url = String(request.data?.url ?? "").trim();
      if (!url || url.length > LIMITS.MAX_SOURCE_URL_LENGTH) {
        throw new HttpsError("invalid-argument", "Invalid source URL");
      }
      if (!(url.startsWith("http://") || url.startsWith("https://"))) {
        throw new HttpsError("invalid-argument", "URL must be http(s)");
      }
      const urlEnc = encryptPayload(url, "the source URL");
      payload = {
        label: label || "Source",
        kind: FieldValue.delete(),
        urlEnc,
        xtreamEnc: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    } else {
      let baseUrl = String(request.data?.xtreamBaseUrl ?? "").trim();
      const username = String(request.data?.xtreamUsername ?? "").trim();
      let password = String(request.data?.xtreamPassword ?? "");
      if (baseUrl.length > LIMITS.MAX_XTREAM_BASE_URL_LENGTH) {
        throw new HttpsError("invalid-argument", "Xtream base URL is too long");
      }
      if (!username || username.length > LIMITS.MAX_XTREAM_USERNAME_LENGTH) {
        throw new HttpsError("invalid-argument", "Invalid Xtream username");
      }
      if (password.length > LIMITS.MAX_XTREAM_PASSWORD_LENGTH) {
        throw new HttpsError("invalid-argument", "Xtream password is too long");
      }
      try {
        baseUrl = normalizeXtreamBaseUrl(baseUrl);
      } catch (e) {
        const m = e instanceof Error ? e.message : "Invalid Xtream base URL";
        throw new HttpsError("invalid-argument", m);
      }
      if (editSnap) {
        const prev = editSnap.data() as { kind?: string; xtreamEnc?: { iv: string; tag: string; data: string } };
        if ((!password || password === "") && prev.kind === "xtream" && prev.xtreamEnc) {
          try {
            const old = JSON.parse(decryptUtf8(prev.xtreamEnc)) as { password?: string };
            if (typeof old.password === "string" && old.password.length > 0) password = old.password;
          } catch {
            /* fall through to empty check */
          }
        }
      }
      if (!password) {
        throw new HttpsError("invalid-argument", "Xtream password is required for a new source (or when changing it)");
      }
      const xtreamJson = JSON.stringify({ baseUrl, username, password });
      const xtreamEnc = encryptPayload(xtreamJson, "Xtream credentials");
      payload = {
        label: label || "Xtream source",
        kind: "xtream",
        xtreamEnc,
        urlEnc: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    }

    try {
      if (id) {
        await db.collection("sources").doc(id).update(payload);
        return { id };
      }

      /** `set()` must not include `FieldValue.delete()` — only `update()` supports delete sentinels. */
      const ref = db.collection("sources").doc();
      if (sourceType === "m3u") {
        const urlEnc = payload.urlEnc as ReturnType<typeof encryptUtf8>;
        await ref.set({
          ownerUid: uid,
          label: payload.label as string,
          urlEnc,
          createdAt: FieldValue.serverTimestamp(),
        });
      } else {
        const xtreamEnc = payload.xtreamEnc as ReturnType<typeof encryptUtf8>;
        await ref.set({
          ownerUid: uid,
          label: payload.label as string,
          kind: "xtream",
          xtreamEnc,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return { id: ref.id };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("upsertSource Firestore error", e);
      throw new HttpsError(
        "failed-precondition",
        "Could not save the source. Check Functions logs and Firestore status.",
      );
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("upsertSource unexpected error", e);
    throw new HttpsError(
      "failed-precondition",
      "Could not add this source. In Firebase Console open Functions → upsertSource → Logs. If you deploy from CI, set Secret IPTV_ENCRYPTION_KEY to the same base64 key as in functions/.env, then redeploy.",
    );
  }
});

export const deleteSource = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const id = String(request.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "Missing id");
  const ref = db.collection("sources").doc(id);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Source not found");
  }
  await ref.delete();
  return { ok: true };
});

export const createPlaylist = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  if ((await countUserPlaylists(uid)) >= LIMITS.MAX_PLAYLISTS_PER_USER) {
    throw new HttpsError("resource-exhausted", "Playlist limit reached");
  }
  const name = String(request.data?.name ?? "My playlist").slice(0, LIMITS.MAX_PLAYLIST_NAME_LENGTH);
  const sourceIds = (request.data?.sourceIds as string[] | undefined) ?? [];
  if (!Array.isArray(sourceIds) || sourceIds.length > LIMITS.MAX_SOURCES_PER_USER) {
    throw new HttpsError("invalid-argument", "Invalid sourceIds");
  }
  for (const sid of sourceIds) {
    const s = await db.collection("sources").doc(sid).get();
    if (!s.exists || (s.data() as { ownerUid?: string }).ownerUid !== uid) {
      throw new HttpsError("invalid-argument", "Unknown source");
    }
  }

  const publicToken = randomBytes(24).toString("hex");
  const ref = db.collection("playlists").doc();
  const batch = db.batch();
  batch.set(ref, {
    ownerUid: uid,
    name,
    publicToken,
    sourceIds,
    rules: { ...DEFAULT_RULES },
    enrichEnabled: false,
    duplicateNewIntoLatest: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    nextScheduledRefreshAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  batch.set(db.collection("playlistIndex").doc(publicToken), { playlistId: ref.id });
  await batch.commit();
  return { id: ref.id, publicToken };
});

export const updatePlaylist = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const id = String(request.data?.id ?? "");
  if (!id) throw new HttpsError("invalid-argument", "Missing id");
  const ref = db.collection("playlists").doc(id);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }

  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (request.data?.name != null) patch.name = String(request.data.name).slice(0, LIMITS.MAX_PLAYLIST_NAME_LENGTH);
  if (request.data?.rules != null) patch.rules = mergePlaylistRules(request.data.rules);
  if (request.data?.sourceIds != null) {
    const sourceIds = request.data.sourceIds as string[];
    if (!Array.isArray(sourceIds) || sourceIds.length > LIMITS.MAX_SOURCES_PER_USER) {
      throw new HttpsError("invalid-argument", "Invalid sourceIds");
    }
    for (const sid of sourceIds) {
      const s = await db.collection("sources").doc(sid).get();
      if (!s.exists || (s.data() as { ownerUid?: string }).ownerUid !== uid) {
        throw new HttpsError("invalid-argument", "Unknown source");
      }
    }
    patch.sourceIds = sourceIds;
  }
  if (request.data?.enrichEnabled != null) patch.enrichEnabled = Boolean(request.data.enrichEnabled);
  if (request.data?.duplicateNewIntoLatest != null) {
    patch.duplicateNewIntoLatest = Boolean(request.data.duplicateNewIntoLatest);
  }
  if (request.data?.maxChannelsToLoad !== undefined) {
    const raw = (request.data as { maxChannelsToLoad?: unknown }).maxChannelsToLoad;
    if (raw === null) {
      patch.maxChannelsToLoad = FieldValue.delete();
    } else {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || n < 1) {
        throw new HttpsError("invalid-argument", "maxChannelsToLoad must be null or an integer >= 1");
      }
      patch.maxChannelsToLoad = Math.min(LIMITS.MAX_CHANNELS_PER_PLAYLIST, n);
    }
  }

  await ref.update(patch);
  return { ok: true };
});

export const refreshPlaylist = onCall(
  { ...RUN_INVOKER_PUBLIC, memory: "1GiB", timeoutSeconds: 540, secrets: [encryptionKeySecret] },
  async (request) => {
    requireAuth(request.auth?.uid);
    const uid = request.auth!.uid;
    const playlistId = String(request.data?.playlistId ?? "");
    if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");

    const tmdb = process.env.TMDB_API_KEY?.trim();
    try {
      const { channelCount, etag } = await runPlaylistRefresh({
        db,
        bucket,
        ownerUid: uid,
        playlistId,
        tmdbApiKey: tmdb || undefined,
      });
      return { ok: true, channelCount, etag };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Refresh failed";
      await db
        .collection("playlists")
        .doc(playlistId)
        .update({
          lastError: msg,
          refreshProgress: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => undefined);
      // Use failed-precondition so the client surfaces `message` instead of a generic internal code.
      throw new HttpsError("failed-precondition", msg);
    }
  },
);

export const getDiffSummary = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  const snap = await db.collection("playlists").doc(playlistId).get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }
  const f = bucket.file(`users/${uid}/playlists/${playlistId}/diff-summary.json`);
  const [exists] = await f.exists();
  if (!exists) return { summary: null };
  const [buf] = await f.download();
  return { summary: JSON.parse(buf.toString("utf8")) };
});

/** Paginated channel rows + rules for the visual playlist organizer (auth). */
export const getPlaylistEditorData = onCall(
  { ...RUN_INVOKER_PUBLIC, memory: "512MiB", timeoutSeconds: 120 },
  async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  const offset = Math.max(0, Math.floor(Number((request.data as { offset?: unknown })?.offset ?? 0)));
  const limitRaw = Math.floor(Number((request.data as { limit?: unknown })?.limit ?? LIMITS.MAX_EDITOR_PAGE_SIZE));
  const limit = Math.min(LIMITS.MAX_EDITOR_PAGE_SIZE, Math.max(50, limitRaw));
  const dataSetRaw = String((request.data as { dataSet?: unknown })?.dataSet ?? "player").trim().toLowerCase();
  const dataSet = dataSetRaw === "rulesdropped" || dataSetRaw === "rules_dropped" ? "rulesDropped" : "player";
  const tabRaw = String((request.data as { tab?: unknown })?.tab ?? "all").trim().toLowerCase();
  const tabFilter = tabRaw === "tv" || tabRaw === "movie" || tabRaw === "series" ? tabRaw : "all";
  const searchRaw = String((request.data as { search?: unknown })?.search ?? "").trim();
  const searchNeedle = searchRaw.slice(0, LIMITS.MAX_EDITOR_SEARCH_CHARS).toLowerCase();

  const snap = await db.collection("playlists").doc(playlistId).get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }
  const data = snap.data() as {
    name?: string;
    publicToken?: string;
    rules?: unknown;
    enrichEnabled?: boolean;
    duplicateNewIntoLatest?: boolean;
    etag?: string;
    editorHydration?: EditorHydrationState;
  };

  const enrichEnabled = Boolean(data.enrichEnabled);
  const filterKey = hashEditorFilterKey(dataSet, tabFilter, searchNeedle);

  const objectPath =
    dataSet === "rulesDropped"
      ? `users/${uid}/playlists/${playlistId}/playlist.editor-rules-dropped.m3u`
      : `users/${uid}/playlists/${playlistId}/playlist.m3u`;
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    if (dataSet === "rulesDropped") {
      return {
        name: data.name ?? "Playlist",
        publicToken: data.publicToken ?? "",
        rules: mergePlaylistRules(data.rules),
        channels: [],
        total: 0,
        offset: 0,
        limit,
        hasMore: false,
        etag: data.etag ?? "",
        enrichEnabled,
        duplicateNewIntoLatest: data.duplicateNewIntoLatest !== false,
        dataSet: "rulesDropped",
        rulesDroppedAvailable: false,
        totalsByTab: { all: 0, tv: 0, movie: 0, series: 0 },
      };
    }
    throw new HttpsError(
      "failed-precondition",
      "No generated playlist file yet. On the main app, run “Refresh player file from sources” once first.",
    );
  }

  const hyd = data.editorHydration;
  if (hyd?.state === "complete" && hyd.filterKey === filterKey && hyd.m3uGeneration) {
    const [srcMeta] = await file.getMetadata();
    const m3uGeneration = String(srcMeta.generation ?? "");
    if (hyd.m3uGeneration === m3uGeneration) {
      const cached = await tryReadEditorRowsFromCache({
        bucket,
        uid,
        playlistId,
        filterKey,
        m3uGeneration,
        offset,
        limit,
      });
      if (cached) {
        const channels = cached.rows;
        return {
          name: data.name ?? "Playlist",
          publicToken: data.publicToken ?? "",
          rules: mergePlaylistRules(data.rules),
          channels,
          total: cached.total,
          offset,
          limit,
          hasMore: offset + channels.length < cached.total,
          etag: data.etag ?? "",
          enrichEnabled,
          duplicateNewIntoLatest: data.duplicateNewIntoLatest !== false,
          dataSet,
          rulesDroppedAvailable: dataSet === "rulesDropped" ? true : undefined,
          totalsByTab: cached.fileTotalsByTab,
        };
      }
    }
  }

  const [buf] = await file.download();
  const text = buf.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new HttpsError("resource-exhausted", "Playlist file is too large for the editor");
  }

  const all = parseM3u(text);
  let totalTv = 0;
  let totalMovie = 0;
  let totalSeries = 0;
  for (const ch of all) {
    const t = classifyEditorTab(ch);
    if (t === "tv") totalTv++;
    else if (t === "movie") totalMovie++;
    else totalSeries++;
  }
  const totalsByTab = { all: all.length, tv: totalTv, movie: totalMovie, series: totalSeries };

  let working = all;
  if (tabFilter !== "all") {
    working = working.filter((ch) => classifyEditorTab(ch) === tabFilter);
  }
  if (searchNeedle.length > 0) {
    working = working.filter((ch) => {
      const title = ch.title.toLowerCase();
      const group = (ch.groupTitle ?? "").toLowerCase();
      const url = ch.url.toLowerCase();
      return title.includes(searchNeedle) || group.includes(searchNeedle) || url.includes(searchNeedle);
    });
  }
  const total = working.length;
  const slice = working.slice(offset, offset + limit);

  const channels = slice.map((ch) => ({
    id: canonicalId(ch),
    title: ch.title,
    groupTitle: ch.groupTitle ?? "",
    url: ch.url,
    tvgLogo: ch.tvgLogo,
    tvgName: ch.tvgName,
    tab: classifyEditorTab(ch),
  }));

  return {
    name: data.name ?? "Playlist",
    publicToken: data.publicToken ?? "",
    rules: mergePlaylistRules(data.rules),
    channels,
    total,
    offset,
    limit,
    hasMore: offset + channels.length < total,
    etag: data.etag ?? "",
    enrichEnabled,
    duplicateNewIntoLatest: data.duplicateNewIntoLatest !== false,
    dataSet,
    rulesDroppedAvailable: dataSet === "rulesDropped" ? true : undefined,
    totalsByTab,
  };
});

/** Advances server-side editor cache hydration (Storage chunks + `editorHydration` on the playlist doc). */
export const editorHydrationTick = onCall(
  { ...RUN_INVOKER_PUBLIC, memory: "512MiB", timeoutSeconds: 120 },
  async (request) => {
    requireAuth(request.auth?.uid);
    const uid = request.auth!.uid;
    const playlistId = String(request.data?.playlistId ?? "");
    if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
    const dataSetRaw = String((request.data as { dataSet?: unknown })?.dataSet ?? "player").trim().toLowerCase();
    const dataSet = dataSetRaw === "rulesdropped" || dataSetRaw === "rules_dropped" ? "rulesDropped" : "player";
    const tabRaw = String((request.data as { tab?: unknown })?.tab ?? "all").trim().toLowerCase();
    const tabFilter = tabRaw === "tv" || tabRaw === "movie" || tabRaw === "series" ? tabRaw : "all";
    const searchRaw = String((request.data as { search?: unknown })?.search ?? "").trim();
    const searchNeedle = searchRaw.slice(0, LIMITS.MAX_EDITOR_SEARCH_CHARS).toLowerCase();

    const snap = await db.collection("playlists").doc(playlistId).get();
    if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
      throw new HttpsError("not-found", "Playlist not found");
    }

    try {
      return await runEditorHydrationTickImpl({
        db,
        bucket,
        uid,
        playlistId,
        dataSet,
        tabFilter,
        searchNeedle,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "not-found") throw new HttpsError("not-found", "Playlist not found");
      throw e;
    }
  },
);

/** All canonical channel ids for the organizer “select entire playlist” action (auth; re-reads Storage M3U). */
export const getPlaylistEditorChannelIds = onCall(
  { ...RUN_INVOKER_PUBLIC, memory: "512MiB", timeoutSeconds: 120 },
  async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");

  const snap = await db.collection("playlists").doc(playlistId).get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }

  const objectPath = `users/${uid}/playlists/${playlistId}/playlist.m3u`;
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError(
      "failed-precondition",
      "No generated playlist file yet. On the main app, run “Refresh player file from sources” once first.",
    );
  }

  const [buf] = await file.download();
  const text = buf.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new HttpsError("resource-exhausted", "Playlist file is too large for the editor");
  }

  const all = parseM3u(text);
  const ids = all.map((ch) => canonicalId(ch));
  return { total: ids.length, ids };
});

/**
 * Adds exclude-by-exact-name patterns for every selected channel id by reading the full generated M3U
 * (same source as “Entire playlist” selection). Use when the selection includes ids not loaded in the editor table.
 */
export const bulkExcludeByNamesForChannelIds = onCall(
  { ...RUN_INVOKER_PUBLIC, memory: "512MiB", timeoutSeconds: 120 },
  async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  const rawIds = (request.data as { channelIds?: unknown })?.channelIds;
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new HttpsError("invalid-argument", "channelIds must be a non-empty array");
  }
  const channelIds = [...new Set(rawIds.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (channelIds.length > LIMITS.MAX_CHANNELS_PER_PLAYLIST) {
    throw new HttpsError("invalid-argument", "Too many channel ids");
  }
  const idSet = new Set(channelIds);

  const ref = db.collection("playlists").doc(playlistId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }

  const objectPath = `users/${uid}/playlists/${playlistId}/playlist.m3u`;
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError(
      "failed-precondition",
      "No generated playlist file yet. On the main app, run “Refresh player file from sources” once first.",
    );
  }

  const [buf] = await file.download();
  const text = buf.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new HttpsError("resource-exhausted", "Playlist file is too large");
  }

  const all = parseM3u(text);
  const foundIds = new Set<string>();
  const titles: string[] = [];
  for (const ch of all) {
    const id = canonicalId(ch);
    if (!idSet.has(id)) continue;
    foundIds.add(id);
    const t = ch.title.trim();
    if (t) titles.push(t);
  }

  const idsMissingFromFile = channelIds.filter((id) => !foundIds.has(id)).length;

  if (titles.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      idsMissingFromFile === channelIds.length
        ? "None of the selected channel ids appear in the current playlist file (rebuild and try again)."
        : "Selected channels have no titles to match on in the playlist file.",
    );
  }

  let newPatterns: string[];
  try {
    newPatterns = buildExcludeNamePatternsFromTitles(titles);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpsError("failed-precondition", msg);
  }

  const data = snap.data() as { rules?: unknown };
  const rules = mergePlaylistRules(data.rules);
  const arr = [...rules.excludeNamePatterns];
  const excludeNamePatternScopes = [...rules.excludeNamePatternScopes];
  while (excludeNamePatternScopes.length < arr.length) excludeNamePatternScopes.push("all");
  excludeNamePatternScopes.length = arr.length;
  let added = 0;
  for (const p of newPatterns) {
    if (!arr.includes(p)) {
      arr.push(p);
      excludeNamePatternScopes.push("all");
      added++;
    }
  }
  const nextRules = { ...rules, excludeNamePatterns: arr, excludeNamePatternScopes };
  try {
    await ref.update({ rules: nextRules, updatedAt: FieldValue.serverTimestamp() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/1048576|longer than|maximum|limit|exceeds|too large|size/i.test(msg)) {
      throw new HttpsError(
        "resource-exhausted",
        "Playlist rules are too large to save (Firestore limit). Remove some older exclude patterns or run exclude on fewer channels at a time.",
      );
    }
    console.error("bulkExcludeByNamesForChannelIds update", e);
    throw new HttpsError("internal", msg || "Could not save playlist rules");
  }

  return {
    ok: true,
    rules: nextRules,
    addedChunks: added,
    totalChunks: newPatterns.length,
    channelRowsMatched: titles.length,
    uniqueTitles: new Set(titles).size,
    idsRequested: channelIds.length,
    idsFoundInFile: foundIds.size,
    idsMissingFromFile,
  };
});

/** Public M3U for IPTV players (no auth). Use `?token=<publicToken>` or path ending in token.m3u */
export const publicPlaylist = onRequest({ ...RUN_INVOKER_PUBLIC, cors: false, memory: "512MiB" }, async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let token = url.searchParams.get("token") ?? "";
  if (!token) {
    const parts = url.pathname.split("/").filter(Boolean);
    token = parts[parts.length - 1] ?? "";
  }
  token = token.replace(/\.m3u$/i, "");
  if (!token || token.length < 16) {
    res.status(404).send("Not found");
    return;
  }
  const idx = await db.collection("playlistIndex").doc(token).get();
  if (!idx.exists) {
    res.status(404).send("Not found");
    return;
  }
  const playlistId = String(idx.data()?.playlistId ?? "");
  const p = await db.collection("playlists").doc(playlistId).get();
  if (!p.exists) {
    res.status(404).send("Not found");
    return;
  }
  const data = p.data() as { publicToken?: string; ownerUid?: string; etag?: string };
  if (data.publicToken !== token) {
    res.status(404).send("Not found");
    return;
  }
  const path = `users/${data.ownerUid}/playlists/${playlistId}/playlist.m3u`;
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) {
    res.status(404).send("Playlist not generated yet. Refresh from the app.");
    return;
  }
  const [meta] = await file.getMetadata();
  const etag = meta.md5Hash ? `"${meta.md5Hash}"` : `"${data.etag ?? "0"}"`;
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("Content-Type", "audio/x-mpegurl; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=120");
  res.setHeader("ETag", etag);
  const [buf] = await file.download();
  res.status(200).send(buf.toString("utf8"));
});

/** Weekly refresh window (MVP plan): Mondays 09:00 UTC; cost-capped batch (15 playlists max per run). */
export const scheduledPlaylistRefresh = onSchedule(
  {
    ...RUN_INVOKER_PUBLIC,
    schedule: "0 9 * * 1",
    timeZone: "Etc/UTC",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [encryptionKeySecret],
  },
  async () => {
    const snap = await db
      .collection("playlists")
      .where("nextScheduledRefreshAt", "<=", Timestamp.now())
      .limit(15)
      .get();
    const tmdb = process.env.TMDB_API_KEY?.trim();
    for (const doc of snap.docs) {
      const d = doc.data() as { ownerUid?: string };
      if (!d.ownerUid) continue;
      try {
        await runPlaylistRefresh({
          db,
          bucket,
          ownerUid: d.ownerUid,
          playlistId: doc.id,
          tmdbApiKey: tmdb || undefined,
        });
      } catch {
        await doc.ref
          .update({
            lastError: "Scheduled refresh failed",
            refreshProgress: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          })
          .catch(() => undefined);
      }
    }
  },
);

/** Callable: rotate public token (invalidates old player URL). */
export const deletePlaylist = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  const ref = db.collection("playlists").doc(playlistId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }
  const token = (snap.data() as { publicToken?: string }).publicToken;
  const batch = db.batch();
  if (token) batch.delete(db.collection("playlistIndex").doc(token));
  batch.delete(ref);
  await batch.commit();
  const [files] = await bucket.getFiles({ prefix: `users/${uid}/playlists/${playlistId}/` });
  await Promise.all(files.map((f) => f.delete().catch(() => undefined)));
  return { ok: true };
});

export const rotatePlaylistToken = onCall(RUN_INVOKER_PUBLIC, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  const ref = db.collection("playlists").doc(playlistId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }
  const oldToken = (snap.data() as { publicToken?: string }).publicToken;
  const newToken = randomBytes(24).toString("hex");
  const batch = db.batch();
  if (oldToken) batch.delete(db.collection("playlistIndex").doc(oldToken));
  batch.set(db.collection("playlistIndex").doc(newToken), { playlistId });
  batch.update(ref, { publicToken: newToken, updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { publicToken: newToken };
});
