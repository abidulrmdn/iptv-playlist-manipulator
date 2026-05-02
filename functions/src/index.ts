import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { randomBytes } from "crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { encryptUtf8 } from "./crypto.js";
import { DEFAULT_RULES, LIMITS } from "./constants.js";
import { classifyEditorTab } from "./editorTab.js";
import { canonicalId, parseM3u } from "./m3u.js";
import { mergePlaylistRules } from "./rules.js";
import { runPlaylistRefresh } from "./refresh.js";

for (const p of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "functions", ".env")]) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

initializeApp();
const db = getFirestore();
const bucket = getStorage().bucket();

setGlobalOptions({ region: "us-central1", maxInstances: 5 });

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

export const upsertSource = onCall(async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const label = String(request.data?.label ?? "").slice(0, LIMITS.MAX_LABEL_LENGTH);
  const url = String(request.data?.url ?? "");
  if (!url || url.length > LIMITS.MAX_SOURCE_URL_LENGTH) {
    throw new HttpsError("invalid-argument", "Invalid source URL");
  }
  if (!(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new HttpsError("invalid-argument", "URL must be http(s)");
  }

  const count = await countUserSources(uid);
  if (count >= LIMITS.MAX_SOURCES_PER_USER) {
    throw new HttpsError("resource-exhausted", "Source limit reached");
  }

  let urlEnc: ReturnType<typeof encryptUtf8>;
  try {
    urlEnc = encryptUtf8(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENCRYPTION_KEY")) {
      throw new HttpsError(
        "failed-precondition",
        "ENCRYPTION_KEY is missing or not 32 bytes after base64 decode. Set it in functions/.env (run: openssl rand -base64 32). Restart emulators after changing it.",
      );
    }
    console.error("upsertSource encrypt error", err);
    throw new HttpsError("internal", "Could not encrypt source URL");
  }

  const id = String(request.data?.id ?? "");
  if (id) {
    const ref = db.collection("sources").doc(id);
    const snap = await ref.get();
    if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
      throw new HttpsError("not-found", "Source not found");
    }
    await ref.update({
      label,
      urlEnc,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { id };
  }

  const ref = db.collection("sources").doc();
  await ref.set({
    ownerUid: uid,
    label: label || "Source",
    urlEnc,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
});

export const deleteSource = onCall(async (request) => {
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

export const createPlaylist = onCall(async (request) => {
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

export const updatePlaylist = onCall(async (request) => {
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
  if (request.data?.rules != null) patch.rules = { ...DEFAULT_RULES, ...request.data.rules };
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

  await ref.update(patch);
  return { ok: true };
});

export const refreshPlaylist = onCall({ memory: "1GiB", timeoutSeconds: 540 }, async (request) => {
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
        .update({ lastError: msg, updatedAt: FieldValue.serverTimestamp() })
        .catch(() => undefined);
      // Use failed-precondition so the client surfaces `message` instead of a generic internal code.
      throw new HttpsError("failed-precondition", msg);
    }
});

export const getDiffSummary = onCall(async (request) => {
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
export const getPlaylistEditorData = onCall({ memory: "512MiB", timeoutSeconds: 120 }, async (request) => {
  requireAuth(request.auth?.uid);
  const uid = request.auth!.uid;
  const playlistId = String(request.data?.playlistId ?? "");
  if (!playlistId) throw new HttpsError("invalid-argument", "Missing playlistId");
  const offset = Math.max(0, Math.floor(Number((request.data as { offset?: unknown })?.offset ?? 0)));
  const limitRaw = Math.floor(Number((request.data as { limit?: unknown })?.limit ?? LIMITS.MAX_EDITOR_PAGE_SIZE));
  const limit = Math.min(LIMITS.MAX_EDITOR_PAGE_SIZE, Math.max(50, limitRaw));

  const snap = await db.collection("playlists").doc(playlistId).get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new HttpsError("not-found", "Playlist not found");
  }
  const data = snap.data() as {
    name?: string;
    rules?: unknown;
    enrichEnabled?: boolean;
    duplicateNewIntoLatest?: boolean;
    etag?: string;
  };

  const objectPath = `users/${uid}/playlists/${playlistId}/playlist.m3u`;
  const file = bucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError(
      "failed-precondition",
      "No generated playlist file yet. Run “Fetch & rebuild M3U” on the main page first.",
    );
  }

  const [buf] = await file.download();
  const text = buf.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new HttpsError("resource-exhausted", "Playlist file is too large for the editor");
  }

  const all = parseM3u(text);
  const total = all.length;
  const slice = all.slice(offset, offset + limit);
  const enrichEnabled = Boolean(data.enrichEnabled);

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
    rules: mergePlaylistRules(data.rules),
    channels,
    total,
    offset,
    limit,
    hasMore: offset + channels.length < total,
    etag: data.etag ?? "",
    enrichEnabled,
    duplicateNewIntoLatest: data.duplicateNewIntoLatest !== false,
  };
});

/** Public M3U for IPTV players (no auth). Use `?token=<publicToken>` or path ending in token.m3u */
export const publicPlaylist = onRequest({ cors: false, memory: "512MiB" }, async (req, res) => {
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
  { schedule: "0 9 * * 1", timeZone: "Etc/UTC", memory: "1GiB", timeoutSeconds: 540 },
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
        await doc.ref.update({ lastError: "Scheduled refresh failed", updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      }
    }
  },
);

/** Callable: rotate public token (invalidates old player URL). */
export const deletePlaylist = onCall(async (request) => {
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

export const rotatePlaylistToken = onCall(async (request) => {
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
