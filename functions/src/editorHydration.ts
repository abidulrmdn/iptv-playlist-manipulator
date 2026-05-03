import { createHash } from "node:crypto";
import type { Bucket } from "@google-cloud/storage";
import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { LIMITS } from "./constants.js";
import { classifyEditorTab } from "./editorTab.js";
import { canonicalId, iterateM3uChannels, type ChannelEntry } from "./m3u.js";

export type EditorDataSet = "player" | "rulesDropped";

export type EditorHydrationState = {
  state: "idle" | "running" | "complete" | "failed";
  dataSet: EditorDataSet;
  filterKey: string;
  m3uGeneration?: string;
  indexedThrough: number;
  chunkFilesWritten: number;
  /** Row count per part file (for resume + cache reads). */
  partRowCounts?: number[];
  filteredTotal?: number;
  message?: string;
  updatedAt?: Timestamp;
};

export type EditorRowJson = {
  id: string;
  title: string;
  groupTitle: string;
  url: string;
  tvgLogo?: string;
  tvgName?: string;
  tab: ReturnType<typeof classifyEditorTab>;
};

export type EditorCacheMeta = {
  version: 1;
  m3uGeneration: string;
  filterKey: string;
  totalFiltered: number;
  partRowCounts: number[];
  /** Full-file tab counts (unfiltered) for organizer tab badges. */
  fileTotalsByTab: { all: number; tv: number; movie: number; series: number };
};

export function hashEditorFilterKey(dataSet: EditorDataSet, tabFilter: string, searchNeedle: string): string {
  const raw = `${dataSet}|${tabFilter}|${searchNeedle}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function channelPassesFilter(ch: ChannelEntry, tabFilter: string, searchNeedle: string): boolean {
  if (tabFilter !== "all") {
    const t = classifyEditorTab(ch);
    if (t !== tabFilter) return false;
  }
  if (searchNeedle.length === 0) return true;
  const sq = searchNeedle;
  const title = ch.title.toLowerCase();
  const group = (ch.groupTitle ?? "").toLowerCase();
  const url = ch.url.toLowerCase();
  return title.includes(sq) || group.includes(sq) || url.includes(sq);
}

function toEditorRow(ch: ChannelEntry): EditorRowJson {
  return {
    id: canonicalId(ch),
    title: ch.title,
    groupTitle: ch.groupTitle ?? "",
    url: ch.url,
    tvgLogo: ch.tvgLogo,
    tvgName: ch.tvgName,
    tab: classifyEditorTab(ch),
  };
}

export function cachePrefix(uid: string, playlistId: string, filterKey: string): string {
  return `users/${uid}/playlists/${playlistId}/editor-cache/${filterKey}`;
}

function stagingPath(uid: string, playlistId: string, filterKey: string): string {
  return `${cachePrefix(uid, playlistId, filterKey)}/staging.m3u`;
}

export function partPath(uid: string, playlistId: string, filterKey: string, partIndex: number): string {
  return `${cachePrefix(uid, playlistId, filterKey)}/part-${String(partIndex).padStart(5, "0")}.json`;
}

function metaPath(uid: string, playlistId: string, filterKey: string): string {
  return `${cachePrefix(uid, playlistId, filterKey)}/meta.json`;
}

async function deleteCachePrefix(bucket: Bucket, prefix: string): Promise<void> {
  const [files] = await bucket.getFiles({ prefix: `${prefix}/` });
  await Promise.all(files.map((f) => f.delete().catch(() => undefined)));
}

let lastProgressWrite = 0;

async function writeProgress(db: Firestore, playlistId: string, hyd: EditorHydrationState): Promise<void> {
  const now = Date.now();
  if (now - lastProgressWrite < LIMITS.EDITOR_HYDRATION_PROGRESS_MIN_MS && hyd.state === "running") return;
  lastProgressWrite = now;
  await db.collection("playlists").doc(playlistId).update({
    editorHydration: { ...hyd, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown>,
  });
}

export async function editorHydrationTick(params: {
  db: Firestore;
  bucket: Bucket;
  uid: string;
  playlistId: string;
  dataSet: EditorDataSet;
  tabFilter: string;
  searchNeedle: string;
}): Promise<{
  state: EditorHydrationState["state"];
  indexedThrough: number;
  filteredTotal?: number;
  chunkFilesWritten: number;
  message?: string;
}> {
  const { db, bucket, uid, playlistId, dataSet, tabFilter, searchNeedle } = params;
  const filterKey = hashEditorFilterKey(dataSet, tabFilter, searchNeedle);
  const pref = cachePrefix(uid, playlistId, filterKey);

  const ref = db.collection("playlists").doc(playlistId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as { ownerUid?: string }).ownerUid !== uid) {
    throw new Error("not-found");
  }

  const objectPath =
    dataSet === "rulesDropped"
      ? `users/${uid}/playlists/${playlistId}/playlist.editor-rules-dropped.m3u`
      : `users/${uid}/playlists/${playlistId}/playlist.m3u`;
  const srcFile = bucket.file(objectPath);
  const [exists] = await srcFile.exists();
  if (!exists) {
    const failed: EditorHydrationState = {
      state: "failed",
      dataSet,
      filterKey,
      indexedThrough: 0,
      chunkFilesWritten: 0,
      message: "No playlist file for this data source yet.",
    };
    await ref.update({ editorHydration: { ...failed, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown> });
    return { state: "failed", indexedThrough: 0, chunkFilesWritten: 0, message: failed.message };
  }

  const [srcMeta] = await srcFile.getMetadata();
  const m3uGeneration = String(srcMeta.generation ?? "");

  const [metaExists] = await bucket.file(metaPath(uid, playlistId, filterKey)).exists();
  if (metaExists) {
    const [mbuf] = await bucket.file(metaPath(uid, playlistId, filterKey)).download();
    const metaJson = JSON.parse(mbuf.toString("utf8")) as EditorCacheMeta;
    if (metaJson.m3uGeneration === m3uGeneration) {
      const total = metaJson.totalFiltered ?? 0;
      const done: EditorHydrationState = {
        state: "complete",
        dataSet,
        filterKey,
        m3uGeneration,
        indexedThrough: total,
        chunkFilesWritten: metaJson.partRowCounts?.length ?? 0,
        partRowCounts: metaJson.partRowCounts,
        filteredTotal: total,
      };
      await ref.update({ editorHydration: { ...done, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown> });
      return { state: "complete", indexedThrough: total, filteredTotal: total, chunkFilesWritten: done.chunkFilesWritten };
    }
  }

  const docHyd = (snap.data() as { editorHydration?: EditorHydrationState }).editorHydration;
  const restart =
    !docHyd ||
    docHyd.filterKey !== filterKey ||
    docHyd.m3uGeneration !== m3uGeneration ||
    docHyd.state === "failed" ||
    docHyd.state === "idle" ||
    docHyd.state === "complete";

  if (restart) {
    await deleteCachePrefix(bucket, pref);
    const [buf] = await srcFile.download();
    if (Buffer.byteLength(buf, "utf8") > LIMITS.MAX_M3U_BYTES) {
      const failed: EditorHydrationState = {
        state: "failed",
        dataSet,
        filterKey,
        m3uGeneration,
        indexedThrough: 0,
        chunkFilesWritten: 0,
        message: "Playlist file too large for editor cache.",
      };
      await ref.update({ editorHydration: { ...failed, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown> });
      return { state: "failed", indexedThrough: 0, chunkFilesWritten: 0 };
    }
    await bucket.file(stagingPath(uid, playlistId, filterKey)).save(buf, {
      contentType: "audio/x-mpegurl",
      resumable: false,
      metadata: { cacheControl: "private, max-age=0" },
    });
    lastProgressWrite = 0;
    const startHyd: EditorHydrationState = {
      state: "running",
      dataSet,
      filterKey,
      m3uGeneration,
      indexedThrough: 0,
      chunkFilesWritten: 0,
      partRowCounts: [],
    };
    await ref.update({ editorHydration: { ...startHyd, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown> });
  }

  const snap2 = await ref.get();
  const hyd0 = (snap2.data() as { editorHydration?: EditorHydrationState }).editorHydration!;
  const partRowCounts: number[] = Array.isArray(hyd0.partRowCounts) ? [...hyd0.partRowCounts] : [];
  const sumParts = () => partRowCounts.reduce((a, b) => a + b, 0);
  let indexedThrough = sumParts();
  let chunkFilesWritten = partRowCounts.length;

  const [sbuf] = await bucket.file(stagingPath(uid, playlistId, filterKey)).download();
  const text = sbuf.toString("utf8");

  const chunkRows = LIMITS.EDITOR_HYDRATION_CHUNK_ROWS;
  const buffer: EditorRowJson[] = [];
  const t0 = Date.now();
  let processedThisTick = 0;
  let filteredIndex = 0;
  let hitBudget = false;

  const flush = async (rows: EditorRowJson[]) => {
    if (rows.length === 0) return;
    const body = JSON.stringify(rows);
    const partIdx = partRowCounts.length;
    await bucket.file(partPath(uid, playlistId, filterKey, partIdx)).save(body, {
      contentType: "application/json",
      resumable: false,
    });
    partRowCounts.push(rows.length);
    indexedThrough = sumParts();
    chunkFilesWritten = partRowCounts.length;
    await writeProgress(db, playlistId, {
      state: "running",
      dataSet,
      filterKey,
      m3uGeneration,
      indexedThrough,
      chunkFilesWritten,
      partRowCounts,
    });
  };

  for (const ch of iterateM3uChannels(text)) {
    if (!channelPassesFilter(ch, tabFilter, searchNeedle)) continue;
    if (filteredIndex < indexedThrough) {
      filteredIndex++;
      continue;
    }
    buffer.push(toEditorRow(ch));
    filteredIndex++;
    processedThisTick++;
    if (buffer.length >= chunkRows) {
      await flush(buffer.splice(0, chunkRows));
    }
    if (processedThisTick >= LIMITS.EDITOR_HYDRATION_TICK_MAX_FILTERED) {
      hitBudget = true;
      break;
    }
    if (Date.now() - t0 > 52_000) {
      hitBudget = true;
      break;
    }
  }

  if (buffer.length > 0) {
    await flush(buffer);
  }

  if (hitBudget) {
    await writeProgress(db, playlistId, {
      state: "running",
      dataSet,
      filterKey,
      m3uGeneration,
      indexedThrough,
      chunkFilesWritten,
      partRowCounts,
    });
    return { state: "running", indexedThrough, chunkFilesWritten };
  }

  const totalFiltered = filteredIndex;
  let uTv = 0;
  let uMovie = 0;
  let uSeries = 0;
  for (const ch of iterateM3uChannels(text)) {
    const t = classifyEditorTab(ch);
    if (t === "tv") uTv++;
    else if (t === "movie") uMovie++;
    else uSeries++;
  }
  const fileTotalsByTab = { all: uTv + uMovie + uSeries, tv: uTv, movie: uMovie, series: uSeries };

  const metaOut: EditorCacheMeta = {
    version: 1,
    m3uGeneration,
    filterKey,
    totalFiltered: totalFiltered,
    partRowCounts,
    fileTotalsByTab,
  };
  await bucket.file(metaPath(uid, playlistId, filterKey)).save(JSON.stringify(metaOut), {
    contentType: "application/json",
    resumable: false,
  });

  const done: EditorHydrationState = {
    state: "complete",
    dataSet,
    filterKey,
    m3uGeneration,
    indexedThrough: totalFiltered,
    chunkFilesWritten: partRowCounts.length,
    partRowCounts,
    filteredTotal: totalFiltered,
  };
  await ref.update({ editorHydration: { ...done, updatedAt: FieldValue.serverTimestamp() } as Record<string, unknown> });

  return {
    state: "complete",
    indexedThrough: totalFiltered,
    filteredTotal: totalFiltered,
    chunkFilesWritten: partRowCounts.length,
  };
}

export async function tryReadEditorRowsFromCache(params: {
  bucket: Bucket;
  uid: string;
  playlistId: string;
  filterKey: string;
  m3uGeneration: string;
  offset: number;
  limit: number;
}): Promise<{ rows: EditorRowJson[]; total: number; fileTotalsByTab: EditorCacheMeta["fileTotalsByTab"] } | null> {
  const { bucket, uid, playlistId, filterKey, m3uGeneration, offset, limit } = params;
  const metaFile = bucket.file(metaPath(uid, playlistId, filterKey));
  const [exists] = await metaFile.exists();
  if (!exists) return null;
  const [mbuf] = await metaFile.download();
  const meta = JSON.parse(mbuf.toString("utf8")) as EditorCacheMeta;
  if (meta.m3uGeneration !== m3uGeneration) return null;
  const total = meta.totalFiltered ?? 0;
  const counts = meta.partRowCounts ?? [];
  if (counts.length === 0) return total === 0 ? { rows: [], total, fileTotalsByTab: meta.fileTotalsByTab } : null;
  if (offset >= total) return { rows: [], total, fileTotalsByTab: meta.fileTotalsByTab };

  const cum: number[] = [0];
  for (const n of counts) {
    cum.push(cum[cum.length - 1]! + n);
  }

  const out: EditorRowJson[] = [];
  let remaining = limit;
  let pos = offset;
  while (remaining > 0 && pos < total) {
    let partIdx = 0;
    for (let i = 0; i < counts.length; i++) {
      if (pos >= cum[i]! && pos < cum[i + 1]!) {
        partIdx = i;
        break;
      }
    }
    const startInPart = pos - cum[partIdx]!;
    const partFile = bucket.file(partPath(uid, playlistId, filterKey, partIdx));
    const [pex] = await partFile.exists();
    if (!pex) return null;
    const [pbuf] = await partFile.download();
    const arr = JSON.parse(pbuf.toString("utf8")) as EditorRowJson[];
    const slice = arr.slice(startInPart, startInPart + remaining);
    out.push(...slice);
    remaining -= slice.length;
    pos += slice.length;
  }
  return { rows: out, total, fileTotalsByTab: meta.fileTotalsByTab };
}

export async function invalidateEditorHydrationCache(
  db: Firestore,
  bucket: Bucket,
  uid: string,
  playlistId: string,
): Promise<void> {
  const base = `users/${uid}/playlists/${playlistId}/editor-cache`;
  await deleteCachePrefix(bucket, base);
  await db
    .collection("playlists")
    .doc(playlistId)
    .update({
      editorHydration: FieldValue.delete(),
    })
    .catch(() => undefined);
}
