import { createHash } from "crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Bucket } from "@google-cloud/storage";
import { decryptUtf8, type EncPayload } from "./crypto.js";
import { DEFAULT_RULES, LIMITS, type PlaylistRules } from "./constants.js";
import { applyRules } from "./rules.js";
import { canonicalId, parseM3u, serializeM3u, type ChannelEntry } from "./m3u.js";
import { enrichWithTmdb } from "./enrich.js";

export type SourceDoc = {
  ownerUid: string;
  label: string;
  urlEnc: EncPayload;
  createdAt: Timestamp;
};

export type PlaylistDoc = {
  ownerUid: string;
  name: string;
  publicToken: string;
  sourceIds: string[];
  rules: PlaylistRules;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  enrichEnabled?: boolean;
  duplicateNewIntoLatest?: boolean;
  nextScheduledRefreshAt?: Timestamp;
};

function assertLimits(sourcesCount: number, channels: number) {
  if (sourcesCount > LIMITS.MAX_SOURCES_PER_USER) {
    throw new Error(`Too many sources (max ${LIMITS.MAX_SOURCES_PER_USER})`);
  }
  if (channels > LIMITS.MAX_CHANNELS_PER_PLAYLIST) {
    throw new Error(`Too many channels (max ${LIMITS.MAX_CHANNELS_PER_PLAYLIST})`);
  }
}

async function fetchM3u(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "IPTV-List-Manager/1.0",
        Accept: "application/vnd.apple.mpegurl, audio/x-mpegurl, */*",
      },
    });
    if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > LIMITS.MAX_M3U_BYTES) throw new Error("Upstream M3U exceeds size limit");
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

function mergeRules(raw: unknown): PlaylistRules {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RULES };
  return { ...DEFAULT_RULES, ...(raw as PlaylistRules) };
}

function buildFinalChannels(params: {
  stable: ChannelEntry[];
  previousIds: Set<string>;
  hadPreviousSnapshot: boolean;
  rules: PlaylistRules;
  duplicateNewIntoLatest: boolean;
}): ChannelEntry[] {
  const { stable, previousIds, hadPreviousSnapshot, rules, duplicateNewIntoLatest } = params;
  const latestName = rules.latestGroupName || "Latest fetch";
  const prefix = rules.newMarkerPrefix ?? "[NEW] ";

  if (!hadPreviousSnapshot || previousIds.size === 0) {
    return stable.map((c) => ({ ...c }));
  }

  const newIds = new Set<string>();
  for (const ch of stable) {
    const id = canonicalId(ch);
    if (!previousIds.has(id)) newIds.add(id);
  }

  const out: ChannelEntry[] = [];
  for (const ch of stable) {
    const id = canonicalId(ch);
    const isNew = newIds.has(id);
    if (!isNew) {
      out.push({ ...ch });
      continue;
    }
    const gt = ch.groupTitle ?? "Uncategorized";
    const markedGroup = gt.startsWith(prefix) ? gt : `${prefix}${gt}`;
    out.push({ ...ch, groupTitle: markedGroup });
    if (duplicateNewIntoLatest) {
      out.push({
        ...ch,
        groupTitle: latestName,
      });
    }
  }
  return out;
}

export async function runPlaylistRefresh(params: {
  db: Firestore;
  bucket: Bucket;
  ownerUid: string;
  playlistId: string;
  tmdbApiKey?: string;
}): Promise<{ channelCount: number; etag: string }> {
  const { db, bucket, ownerUid, playlistId, tmdbApiKey } = params;
  const pref = `users/${ownerUid}/playlists/${playlistId}`;

  const pSnap = await db.collection("playlists").doc(playlistId).get();
  if (!pSnap.exists) throw new Error("Playlist not found");
  const playlist = pSnap.data() as PlaylistDoc;
  if (playlist.ownerUid !== ownerUid) throw new Error("Forbidden");

  const rules = mergeRules(playlist.rules);
  const merged: ChannelEntry[] = [];

  for (const sid of playlist.sourceIds) {
    const sSnap = await db.collection("sources").doc(sid).get();
    if (!sSnap.exists) continue;
    const s = sSnap.data() as SourceDoc;
    if (s.ownerUid !== ownerUid) continue;
    const url = decryptUtf8(s.urlEnc);
    const text = await fetchM3u(url);
    merged.push(...parseM3u(text));
  }

  assertLimits(playlist.sourceIds.length, merged.length);

  let stable = applyRules(merged, rules);
  if (playlist.enrichEnabled && tmdbApiKey) {
    await enrichWithTmdb(stable, tmdbApiKey);
  }

  const prevFile = bucket.file(`${pref}/canonical-ids.json`);
  const [prevExists] = await prevFile.exists();
  let previousIds = new Set<string>();
  if (prevExists) {
    const [buf] = await prevFile.download();
    try {
      const arr = JSON.parse(buf.toString("utf8")) as string[];
      previousIds = new Set(arr);
    } catch {
      previousIds = new Set();
    }
  }

  const stableIds = [...new Set(stable.map((ch) => canonicalId(ch)))];
  const duplicateNewIntoLatest = playlist.duplicateNewIntoLatest !== false;
  const finalChannels = buildFinalChannels({
    stable,
    previousIds,
    hadPreviousSnapshot: prevExists,
    rules,
    duplicateNewIntoLatest,
  });

  let body = serializeM3u(finalChannels);
  if (playlist.enrichEnabled && tmdbApiKey) {
    const attr =
      "# This playlist may include TMDB metadata (https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.";
    body = `#EXTM3U\n${attr}\n${body.replace(/^#EXTM3U\n/, "")}`;
  }

  if (Buffer.byteLength(body, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new Error("Resulting M3U exceeds size limit");
  }

  const etag = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const mainPath = `${pref}/playlist.m3u`;
  await bucket.file(mainPath).save(body, {
    contentType: "audio/x-mpegurl",
    resumable: false,
    metadata: { cacheControl: "public, max-age=300" },
  });

  await bucket.file(`${pref}/canonical-ids.json`).save(JSON.stringify(stableIds), {
    contentType: "application/json",
    resumable: false,
  });

  const newCount =
    prevExists && previousIds.size > 0
      ? stableIds.filter((id) => !previousIds.has(id)).length
      : 0;
  const removedApprox = prevExists ? [...previousIds].filter((id) => !stableIds.includes(id)).length : 0;

  const diffSummary = {
    previousCount: previousIds.size,
    currentCount: stableIds.length,
    newCount,
    removedApprox,
    updatedAt: new Date().toISOString(),
  };
  await bucket.file(`${pref}/diff-summary.json`).save(JSON.stringify(diffSummary), {
    contentType: "application/json",
    resumable: false,
  });

  const nextDue = Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db
    .collection("playlists")
    .doc(playlistId)
    .update({
      updatedAt: FieldValue.serverTimestamp(),
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      channelCount: finalChannels.length,
      etag,
      storagePath: mainPath,
      nextScheduledRefreshAt: nextDue,
    });

  return { channelCount: finalChannels.length, etag };
}
