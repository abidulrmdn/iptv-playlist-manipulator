import { createHash } from "crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Bucket } from "@google-cloud/storage";
import { decryptUtf8, type EncPayload } from "./crypto.js";
import { fetchXtreamM3uText } from "./xtream.js";
import { LIMITS, type PlaylistRules } from "./constants.js";
import { mergePlaylistRules, partitionRulesKeptDropped } from "./rules.js";
import { canonicalId, parseM3u, serializeM3u, type ChannelEntry } from "./m3u.js";
import { enrichWithTmdb } from "./enrich.js";

export type SourceDoc = {
  ownerUid: string;
  label: string;
  /** Legacy M3U URL source; omit when `kind` is `xtream`. */
  urlEnc?: EncPayload;
  /** `xtream` = credentials for `player_api.php`; server builds M3U on refresh. */
  kind?: "m3u" | "xtream";
  xtreamEnc?: EncPayload;
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
  /** Ephemeral UI progress during `runPlaylistRefresh`; deleted on success or failure. */
  refreshProgress?: {
    phase: "fetch" | "rules" | "tmdb" | "write";
    detail?: string;
    sourcesDone: number;
    sourcesTotal: number;
    channelsSoFar: number;
    updatedAt?: Timestamp;
  };
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

function redactFetchUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["username", "password", "pass", "pwd", "token", "key", "apikey", "api_key"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return "(invalid-url)";
  }
}

/** Every response header (sorted) — long values truncated for logs / client error caps. */
function responseHeaderDiagnosticsDetailed(res: Response, requestUrl: string): string[] {
  const lines: string[] = [];
  lines.push(`request URL (redacted): ${redactFetchUrlForLog(requestUrl)}`);
  try {
    const pairs = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of pairs) {
      const vv = v.length > 900 ? `${v.slice(0, 900)}…[truncated]` : v;
      lines.push(`response header ${k}: ${vv}`);
    }
  } catch {
    lines.push("(could not enumerate response headers)");
  }
  lines.push(`response final URL (redacted): ${redactFetchUrlForLog(res.url)}`);
  return lines;
}

/** When `arrayBuffer()` is empty: explain Cloudflare / datacenter blocks and dump full headers. */
function formatEmptyBodyPlaylistHint(
  status: number,
  statusText: string,
  res: Response,
  requestUrl: string,
  host: string,
): string {
  const lines: string[] = [];
  lines.push(
    "The server returned an empty body (0 downloaded bytes), so there is no playlist text to parse. This is not an M3U parsing issue.",
  );
  lines.push(`fetch reported: status=${String(status)} statusText=${JSON.stringify(statusText ?? "")} ok=${String(res.ok)} type=${res.type} redirected=${String(res.redirected)}`);
  const cl = res.headers.get("content-length");
  if (cl != null && !Number.isNaN(Number(cl)) && Number(cl) > 0) {
    lines.push(
      `WARNING: Content-Length is ${cl} but the body read as 0 bytes — the connection may have been cut, a proxy may strip bodies for non-browser clients, or the runtime may not attach a body for this status.`,
    );
  }
  const srv = res.headers.get("server") ?? "";
  const cfRay = res.headers.get("cf-ray") ?? "";
  if (/cloudflare/i.test(srv) || Boolean(cfRay)) {
    lines.push(
      `Cloudflare sits in front of ${host}. A non-standard HTTP status (e.g. 884) with Content-Type text/html and an empty body usually means the edge blocked or filtered this request from a Google Cloud / datacenter egress IP. The same URL may still work in a browser on a residential network.`,
    );
    lines.push(
      "Mitigations: download the M3U on your PC and host it somewhere that allows your backend to fetch; ask the provider to allowlist Google Cloud egress; use a residential/VPN relay you control; or use a smaller public index URL if the panel offers one.",
    );
  } else {
    lines.push(
      "If the URL works in a browser, the upstream may be returning a different response (or no body) to server-side fetch — try the mitigations above.",
    );
  }
  lines.push("---");
  lines.push(...responseHeaderDiagnosticsDetailed(res, requestUrl));
  return lines.join("\n");
}

function formatHexPrefix(buf: Buffer, maxBytes: number): string {
  const n = Math.min(maxBytes, buf.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(buf[i]!.toString(16).padStart(2, "0"));
  return parts.join(" ");
}

/** One-line preview: printable ASCII + spaces, no newlines (for error messages). */
function oneLineUtf8Preview(s: string, maxLen: number): string {
  const t = s
    .slice(0, maxLen)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "·");
  return t.length >= maxLen ? `${t}…` : t;
}

type DecompressTrace = { buf: Buffer; lines: string[] };

/** Gzip / zlib without relying on `Content-Encoding` (some IPTV panels omit it). */
function decompressPlaylistWithTrace(raw: Buffer): DecompressTrace {
  const lines: string[] = [];
  lines.push(`raw body: ${raw.length} bytes (limit ${LIMITS.MAX_M3U_BYTES})`);
  if (raw.length === 0) {
    lines.push("body is empty (0 bytes)");
    return { buf: raw, lines };
  }
  lines.push(`first bytes (hex): ${formatHexPrefix(raw, 24)}`);

  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      const out = gunzipSync(raw, { maxOutputLength: LIMITS.MAX_M3U_BYTES });
      lines.push(`gzip: decompressed OK → ${out.length} bytes`);
      return { buf: out, lines };
    } catch (e) {
      lines.push(`gzip: magic 1f8b present but gunzip failed (${e instanceof Error ? e.message : String(e)}) — probing raw bytes as text`);
      return { buf: raw, lines };
    }
  }
  lines.push("gzip: no (magic 1f 8b not at start)");

  if (
    raw.length >= 2 &&
    raw[0] === 0x78 &&
    (raw[1] === 0x9c || raw[1] === 0x01 || raw[1] === 0xda || raw[1] === 0x5e || raw[1] === 0x7c)
  ) {
    try {
      const out = inflateSync(raw, { maxOutputLength: LIMITS.MAX_M3U_BYTES });
      lines.push(`zlib/inflate: OK → ${out.length} bytes`);
      return { buf: out, lines };
    } catch (e) {
      lines.push(`zlib/inflate: failed (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    lines.push("zlib: no common 78** deflate header at start");
  }

  return { buf: raw, lines };
}

function m3uMarkerDiagnostics(utf8: string, latin1: string): string[] {
  const lines: string[] = [];
  const u = utf8.match(/#EXTM3U\b/i);
  lines.push(`utf8 #EXTM3U regex: ${u ? `match at index ${u.index}` : "no match"}`);
  const l = latin1.match(/#EXTM3U\b/i);
  lines.push(`latin1 #EXTM3U regex: ${l ? `match at index ${l.index}` : "no match"}`);
  const looseU = utf8.match(/EXTM3U/i);
  lines.push(`utf8 contains "EXTM3U" (any case): ${looseU ? `yes near ${looseU.index}` : "no"}`);
  lines.push(`utf8 contains "#EXTINF": ${/#EXTINF/i.test(utf8) ? "yes" : "no"}`);
  lines.push(`utf8 contains "m3u" token: ${/\bm3u\b/i.test(utf8) ? "yes" : "no"}`);
  return lines;
}

/**
 * Turn raw bytes into M3U text: decompress if needed, reject obvious HTML, strip junk before first `#EXTM3U`.
 * On failure, throws with multi-line diagnostics (headers, decompression, previews).
 */
function normalizeFetchedM3uPayload(buf: Buffer, host: string, res: Response, requestUrl: string): string {
  const headerLines = responseHeaderDiagnosticsDetailed(res, requestUrl);
  if (buf.length > LIMITS.MAX_M3U_BYTES) {
    throw new Error(
      `Upstream M3U exceeds size limit (${buf.length} bytes > ${LIMITS.MAX_M3U_BYTES}).\n${headerLines.join("\n")}`,
    );
  }

  if (buf.length === 0) {
    const emptyDetail = formatEmptyBodyPlaylistHint(res.status, res.statusText ?? "", res, requestUrl, host);
    console.error(`[fetchM3u] normalize: empty body host=${host} status=${String(res.status)}\n${emptyDetail}`);
    throw new Error(`Empty upstream response from ${host} (0 bytes — not a playlist).\n---\n${emptyDetail}`);
  }

  const { buf: decoded, lines: decompressLines } = decompressPlaylistWithTrace(buf);
  if (decoded.length > LIMITS.MAX_M3U_BYTES) {
    throw new Error(
      `Upstream M3U exceeds size limit after decompress (${decoded.length} bytes).\n${[...headerLines, ...decompressLines].join("\n")}`,
    );
  }

  if (decoded.length === 0) {
    const emptyDetail = formatEmptyBodyPlaylistHint(res.status, res.statusText ?? "", res, requestUrl, host);
    const trace = [...headerLines, ...decompressLines].join("\n");
    console.error(`[fetchM3u] normalize: empty after decompress host=${host}\n${trace}\n${emptyDetail}`);
    throw new Error(
      `Empty playlist body from ${host} after decompress (0 bytes — not a playlist).\n---\n${trace}\n---\n${emptyDetail}`,
    );
  }

  const utf8 = decoded.toString("utf8");
  const probeUtf8 = utf8.slice(0, Math.min(utf8.length, 8192)).replace(/^\uFEFF/, "").trimStart();
  if (probeUtf8.startsWith("<!DOCTYPE") || probeUtf8.startsWith("<html") || probeUtf8.startsWith("<HTML")) {
    const detail = [
      ...headerLines,
      ...decompressLines,
      `utf8 preview: ${oneLineUtf8Preview(probeUtf8, 400)}`,
    ].join("\n");
    throw new Error(
      `Upstream returned HTML instead of a playlist (${host}). Wrong URL, login page, captive portal, or firewall.\n---\n${detail}`,
    );
  }

  let m = utf8.match(/#EXTM3U\b/i);
  if (m != null && m.index !== undefined) return utf8.slice(m.index);

  const latin1 = decoded.toString("latin1");
  m = latin1.match(/#EXTM3U\b/i);
  if (m != null && m.index !== undefined) return latin1.slice(m.index);

  const markerLines = m3uMarkerDiagnostics(utf8, latin1);
  const detail = [
    ...headerLines,
    ...decompressLines,
    ...markerLines,
    `utf8 preview (first ~360 chars): ${oneLineUtf8Preview(utf8, 360)}`,
    `latin1 preview (first ~360 chars): ${oneLineUtf8Preview(latin1, 360)}`,
  ].join("\n");
  console.error(`[fetchM3u] missing #EXTM3U host=${host}\n${detail}`);
  throw new Error(
    `Upstream response is not an M3U (missing #EXTM3U) (${host}). If this URL works in a browser, the server may be blocking Google Cloud (try VPN) or returning a different body to datacenter IPs.\n---\n${detail}`,
  );
}

function describeBadHttpStatus(status: number, statusText: string, host: string): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return (
      `non-standard HTTP status ${String(status)} from ${host}. ` +
      `Some IPTV panels and CDNs use custom codes; if the response is not a valid M3U, try another network or VPN, or open the URL in a browser.`
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
    {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      // Avoid compressed bodies in case an edge mishandles decoding for this host.
      "Accept-Encoding": "identity",
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
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > LIMITS.MAX_M3U_BYTES) throw new Error("Upstream M3U exceeds size limit");

        if (buf.length === 0) {
          const emptyDetail = formatEmptyBodyPlaylistHint(status, res.statusText ?? "", res, url, host);
          lastProblem = `${describeBadHttpStatus(status, res.statusText ?? "", host)} — ${emptyDetail}`;
          console.error(`[fetchM3u] empty body host=${host} status=${String(status)}\n${emptyDetail}`);
          break;
        }

        /** Some IPTV hosts return non-RFC status (e.g. 884) or non-2xx while still sending a valid M3U body. */
        let bodyAssertErr: Error | null = null;
        let normalizedM3u: string | null = null;
        try {
          normalizedM3u = normalizeFetchedM3uPayload(buf, host, res, url);
        } catch (e) {
          bodyAssertErr = e instanceof Error ? e : new Error(String(e));
        }

        if (!bodyAssertErr && normalizedM3u != null) {
          const standardStatus = Number.isFinite(status) && status >= 100 && status <= 599;
          if (!standardStatus || !res.ok) {
            console.warn(
              `fetchM3u: using playlist from ${host} despite HTTP ${String(status)} ${res.statusText ?? ""}`.trim(),
            );
          }
          return normalizedM3u;
        }

        const errMsg = bodyAssertErr?.message ?? "Could not read playlist body";

        if (!Number.isFinite(status) || status < 100 || status > 599) {
          lastProblem = `${describeBadHttpStatus(status, res.statusText, host)} — ${errMsg}`;
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

        throw bodyAssertErr ?? new Error(errMsg);
      } catch (e) {
        clearTimeout(t);
        if (
          e instanceof Error &&
          /Upstream M3U exceeds|HTML instead of a playlist|not an M3U|missing #EXTM3U|Empty upstream response|Empty playlist body after decompress/i.test(
            e.message,
          )
        )
          throw e;
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
  const sourcesTotal = Math.max(1, playlist.sourceIds.length);

  let lastProgAt = 0;
  const writeRefreshProgress = async (
    payload: {
      phase: "fetch" | "rules" | "tmdb" | "write";
      detail?: string;
      sourcesDone: number;
      sourcesTotal: number;
      channelsSoFar: number;
    },
    force: boolean,
  ) => {
    const t = Date.now();
    if (!force && t - lastProgAt < LIMITS.REFRESH_PROGRESS_MIN_MS) return;
    lastProgAt = t;
    try {
      await db
        .collection("playlists")
        .doc(playlistId)
        .update({
          refreshProgress: {
            ...payload,
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
    } catch (e) {
      console.error("[runPlaylistRefresh] refreshProgress write failed", e);
    }
  };

  await writeRefreshProgress(
    {
      phase: "fetch",
      detail: "Starting…",
      sourcesDone: 0,
      sourcesTotal: sourcesTotal,
      channelsSoFar: 0,
    },
    true,
  );

  for (let si = 0; si < playlist.sourceIds.length; si++) {
    const sid = playlist.sourceIds[si]!;
    const sSnap = await db.collection("sources").doc(sid).get();
    if (!sSnap.exists) continue;
    const s = sSnap.data() as SourceDoc;
    if (s.ownerUid !== ownerUid) continue;
    if (s.kind !== "xtream" && !s.urlEnc) continue;

    await writeRefreshProgress(
      {
        phase: "fetch",
        detail: `Source ${si + 1} of ${playlist.sourceIds.length}`,
        sourcesDone: si,
        sourcesTotal: sourcesTotal,
        channelsSoFar: merged.length,
      },
      true,
    );

    let text: string;
    if (s.kind === "xtream") {
      if (!s.xtreamEnc) {
        throw new Error("Xtream source is missing stored credentials; remove it and add it again.");
      }
      const plain = decryptUtf8(s.xtreamEnc);
      const cfg = JSON.parse(plain) as { baseUrl: string; username: string; password: string };
      text = await fetchXtreamM3uText(cfg, {
        onProgress: ({ built, detail }) => {
          void writeRefreshProgress(
            {
              phase: "fetch",
              detail: detail || `Xtream · source ${si + 1} of ${playlist.sourceIds.length}`,
              sourcesDone: si,
              sourcesTotal: sourcesTotal,
              channelsSoFar: merged.length + built,
            },
            false,
          );
        },
      });
    } else {
      const url = decryptUtf8(s.urlEnc!);
      text = await fetchM3u(url);
    }
    merged.push(...parseM3u(text));

    await writeRefreshProgress(
      {
        phase: "fetch",
        detail: `Finished source ${si + 1} of ${playlist.sourceIds.length}`,
        sourcesDone: si + 1,
        sourcesTotal: sourcesTotal,
        channelsSoFar: merged.length,
      },
      true,
    );
  }

  assertLimits(playlist.sourceIds.length, merged.length);

  const { kept: stable, dropped: rulesDropped } = partitionRulesKeptDropped(merged, rules);

  await writeRefreshProgress(
    {
      phase: "rules",
      detail: "Applying filters & order",
      sourcesDone: playlist.sourceIds.length,
      sourcesTotal: sourcesTotal,
      channelsSoFar: stable.length,
    },
    true,
  );

  if (playlist.enrichEnabled && tmdbApiKey) {
    await writeRefreshProgress(
      {
        phase: "tmdb",
        detail: "TMDB enrichment",
        sourcesDone: playlist.sourceIds.length,
        sourcesTotal: sourcesTotal,
        channelsSoFar: stable.length,
      },
      true,
    );
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

  await writeRefreshProgress(
    {
      phase: "write",
      detail: "Uploading playlist files",
      sourcesDone: playlist.sourceIds.length,
      sourcesTotal: sourcesTotal,
      channelsSoFar: finalChannels.length,
    },
    true,
  );

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

  const droppedPath = `${pref}/playlist.editor-rules-dropped.m3u`;
  if (rulesDropped.length > 0) {
    const droppedBody = serializeM3u(rulesDropped);
    if (Buffer.byteLength(droppedBody, "utf8") <= LIMITS.MAX_M3U_BYTES) {
      await bucket.file(droppedPath).save(droppedBody, {
        contentType: "audio/x-mpegurl",
        resumable: false,
        metadata: { cacheControl: "private, max-age=0" },
      });
    } else {
      await bucket.file(droppedPath).delete().catch(() => undefined);
    }
  } else {
    await bucket.file(droppedPath).delete().catch(() => undefined);
  }

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
      refreshProgress: FieldValue.delete(),
      channelCount: finalChannels.length,
      etag,
      storagePath: mainPath,
      nextScheduledRefreshAt: nextDue,
    });

  return { channelCount: finalChannels.length, etag };
}
