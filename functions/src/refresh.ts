import { createHash } from "crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Bucket } from "@google-cloud/storage";
import { decryptUtf8, type EncPayload } from "./crypto.js";
import { LIMITS, type PlaylistRules } from "./constants.js";
import { applyRules, mergePlaylistRules } from "./rules.js";
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

/** Rotate `playlist.snapshot-*.m3u` before writing a new main file (Milestone C retention). */
async function rotatePlaylistM3uSnapshots(bucket: Bucket, pref: string, retained: number): Promise<void> {
  if (retained < 1) return;
  const snap = (i: number) => bucket.file(`${pref}/playlist.snapshot-${i}.m3u`);
  const main = bucket.file(`${pref}/playlist.m3u`);
  await snap(retained).delete().catch(() => undefined);
  for (let i = retained - 1; i >= 1; i--) {
    const [ex] = await snap(i).exists();
    if (ex) await snap(i).copy(snap(i + 1));
  }
  const [em] = await main.exists();
  if (em) await main.copy(snap(1));
}

function upstreamHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Statuses where a retry (or alternate User-Agent) may help. */
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);

function assertBodyLooksLikeM3u(buf: Buffer, host: string): void {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 2048)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<!DOCTYPE") || head.startsWith("<html") || head.startsWith("<HTML")) {
    throw new Error(
      `Upstream returned HTML instead of a playlist (${host}). Wrong URL, login page, captive portal, or firewall.`,
    );
  }
  if (!head.startsWith("#EXTM3U")) {
    throw new Error(
      `Upstream response is not an M3U (missing #EXTM3U) (${host}). Open the URL in a browser — it must be a raw playlist file.`,
    );
  }
}

function describeBadHttpStatus(status: number, statusText: string, host: string): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return (
      `non-standard HTTP status ${String(status)} from ${host}. ` +
      `Often a corporate proxy, antivirus HTTPS inspection, or captive portal — try another network or VPN, or paste the URL in a normal browser tab.`
    );
  }
  const st = statusText?.trim();
  return `HTTP ${status}${st ? ` ${st}` : ""} from ${host}`;
}

/**
 * Fetch provider M3U with retries and a browser-like User-Agent fallback (some CDNs block generic clients).
 * iptv-org `index.m3u` and similar large lists are validated as real M3U after download.
 */
async function fetchM3u(url: string): Promise<string> {
  const host = upstreamHost(url);
  const headerVariants: Record<string, string>[] = [
    {
      "User-Agent": "IPTV-List-Manager/1.0 (merged M3U fetch; contact app operator)",
      Accept: "application/vnd.apple.mpegurl, audio/x-mpegurl, application/x-mpegURL, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
  ];

  const timeoutMs = LIMITS.FETCH_M3U_TIMEOUT_MS;
  let lastProblem = "unknown error";

  for (const headers of headerVariants) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          redirect: "follow",
          headers,
        });
        clearTimeout(t);

        const status = res.status;
        if (!Number.isFinite(status) || status < 100 || status > 599) {
          lastProblem = describeBadHttpStatus(status, res.statusText, host);
          break;
        }

        if (!res.ok) {
          lastProblem = describeBadHttpStatus(status, res.statusText, host);
          if (RETRYABLE_HTTP.has(status) && attempt < 2) {
            await sleep(400 * (attempt + 1) ** 2);
            continue;
          }
          break;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > LIMITS.MAX_M3U_BYTES) throw new Error("Upstream M3U exceeds size limit");
        assertBodyLooksLikeM3u(buf, host);
        return buf.toString("utf8");
      } catch (e) {
        clearTimeout(t);
        if (e instanceof Error && /Upstream M3U exceeds|HTML instead|not an M3U/i.test(e.message)) throw e;
        lastProblem = e instanceof Error ? e.message : String(e);
        const isAbort = e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
        const transientNet =
          isAbort || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(lastProblem);
        if (transientNet && attempt < 2) {
          await sleep(400 * (attempt + 1) ** 2);
          continue;
        }
        break;
      }
    }
  }

  throw new Error(`Upstream fetch failed (${host}): ${lastProblem}`);
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

  const rules = mergePlaylistRules(playlist.rules);
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
  await rotatePlaylistM3uSnapshots(bucket, pref, LIMITS.SNAPSHOTS_RETAINED);
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
