import { LIMITS } from "./constants.js";
import { serializeM3u, type ChannelEntry } from "./m3u.js";

/** Stored decrypted in refresh (never log contents). */
export type XtreamCredentialsJson = {
  baseUrl: string;
  username: string;
  password: string;
};

export type FetchXtreamM3uOpts = {
  /** Called as rows are assembled (throttle in caller). `built` is rows for this Xtream source so far. */
  onProgress?: (info: { built: number; detail: string }) => void;
  /** Max rows for this Xtream pull (caller passes remaining room in merged playlist). */
  maxChannels?: number;
};

type XtreamServerInfo = {
  url?: string;
  port?: string;
  https_port?: string;
  server_protocol?: string;
};

type XtreamUserInfo = {
  auth?: string | number;
  username?: string;
  password?: string;
  message?: string;
  allowed_output_formats?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeTitle(name: string): string {
  const t = name.replace(/\r?\n/g, " ").trim() || "Untitled";
  return t.replace(/,/g, "·");
}

/** Strip trailing path/query so we always hit `/player_api.php` on the panel root. */
export function normalizeXtreamBaseUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("Xtream base URL is empty");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Xtream base URL is not a valid http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Xtream base URL must be http or https");
  }
  const host = u.hostname;
  if (!host) throw new Error("Xtream base URL is missing a host");
  const port = u.port ? `:${u.port}` : "";
  return `${u.protocol}//${host}${port}`;
}

function streamBaseUrl(baseInput: string, server: XtreamServerInfo): string {
  const input = new URL(normalizeXtreamBaseUrl(baseInput));
  const wantHttps = input.protocol === "https:";
  const scheme = wantHttps ? "https" : "http";
  const host = (server.url ?? input.hostname).replace(/^\/+|\/+$/g, "");
  const port = wantHttps
    ? String(server.https_port ?? (input.port ? input.port : "443"))
    : String(server.port ?? (input.port ? input.port : "80"));
  return `${scheme}://${host}:${port}`;
}

function pickLiveExtension(formats: string[] | undefined): "ts" | "m3u8" {
  const f = formats ?? [];
  if (f.some((x) => String(x).toLowerCase() === "ts")) return "ts";
  if (f.some((x) => String(x).toLowerCase() === "m3u8")) return "m3u8";
  return "ts";
}

function playerApiUrl(base: string, params: Record<string, string>): string {
  const u = new URL(`${normalizeXtreamBaseUrl(base)}/player_api.php`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function redactXtreamUrl(u: string): string {
  try {
    const x = new URL(u);
    for (const k of ["username", "password"]) if (x.searchParams.has(k)) x.searchParams.set(k, "***");
    return x.toString();
  } catch {
    return "(invalid-url)";
  }
}

async function xtreamFetchBuffer(url: string): Promise<{ status: number; buf: Buffer }> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LIMITS.XTREAM_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    clearTimeout(t);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > LIMITS.XTREAM_MAX_API_RESPONSE_BYTES) {
      throw new Error(
        `Xtream API response exceeds cap (${LIMITS.XTREAM_MAX_API_RESPONSE_BYTES} bytes) for ${redactXtreamUrl(url)}`,
      );
    }
    return { status: res.status, buf };
  } catch (e) {
    clearTimeout(t);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Xtream API request timed out (${LIMITS.XTREAM_HTTP_TIMEOUT_MS}ms) ${redactXtreamUrl(url)}`);
    }
    throw e;
  }
}

async function xtreamFetchJson(url: string): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, buf } = await xtreamFetchBuffer(url);
      if (status === 429 || status === 503) {
        await sleep(400 * (attempt + 1));
        lastErr = new Error(`Xtream HTTP ${String(status)} ${redactXtreamUrl(url)}`);
        continue;
      }
      if (status < 200 || status >= 300) {
        const snippet = buf.toString("utf8").slice(0, 200).replace(/\s+/g, " ");
        throw new Error(`Xtream HTTP ${String(status)} ${redactXtreamUrl(url)} body:${snippet}`);
      }
      const text = buf.toString("utf8").trim();
      if (!text) throw new Error(`Xtream empty JSON body ${redactXtreamUrl(url)}`);
      return JSON.parse(text) as unknown;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("Xtream request failed");
}

function recordArrayish(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.streams)) return o.streams as Record<string, unknown>[];
    if (o.streams === null || o.streams === undefined) return [];
    const vals = Object.values(o).filter((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<
      string,
      unknown
    >[];
    if (
      vals.length > 0 &&
      vals.every((v) => "stream_id" in v || "name" in v || "category_id" in v || "container_extension" in v)
    ) {
      return vals;
    }
  }
  return [];
}

function streamIdFrom(row: Record<string, unknown>): string | null {
  const a = row.stream_id ?? row.id ?? row.num;
  if (a === undefined || a === null) return null;
  return String(a);
}

async function xtreamAuth(cfg: XtreamCredentialsJson): Promise<{
  user: XtreamUserInfo;
  server: XtreamServerInfo;
  liveExt: "ts" | "m3u8";
}> {
  const { baseUrl, username, password } = cfg;
  const data = await xtreamFetchJson(
    playerApiUrl(baseUrl, { username, password }),
  );
  if (!data || typeof data !== "object") throw new Error("Xtream auth: invalid JSON root");
  const root = data as Record<string, unknown>;
  const user = root.user_info as XtreamUserInfo | undefined;
  const server = root.server_info as XtreamServerInfo | undefined;
  if (!user || !server) throw new Error("Xtream auth: missing user_info or server_info");
  const auth = String(user.auth ?? "");
  if (auth !== "1" && auth !== "true") {
    const msg = user.message ? String(user.message) : "auth failed";
    throw new Error(`Xtream login rejected (${msg})`);
  }
  const liveExt = pickLiveExtension(user.allowed_output_formats);
  return { user, server, liveExt };
}

async function fetchCategoryMap(
  cfg: XtreamCredentialsJson,
  action: "get_live_categories" | "get_vod_categories",
): Promise<Map<string, string>> {
  const { baseUrl, username, password } = cfg;
  const data = await xtreamFetchJson(
    playerApiUrl(baseUrl, { username, password, action }),
  );
  const rows = recordArrayish(data);
  const m = new Map<string, string>();
  for (const row of rows) {
    const id = row.category_id ?? row.id;
    const name = row.category_name ?? row.name;
    if (id !== undefined && id !== null && name != null) m.set(String(id), String(name));
  }
  return m;
}

/** Single `player_api.php` streams request (no limit/offset unless `extra` provides them). */
async function fetchStreamsOnce(
  cfg: XtreamCredentialsJson,
  action: "get_live_streams" | "get_vod_streams",
  categoryId: string | undefined,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const { baseUrl, username, password } = cfg;
  const params: Record<string, string> = { username, password, action, ...extra };
  if (categoryId != null) params.category_id = categoryId;
  const data = await xtreamFetchJson(playerApiUrl(baseUrl, params));
  return recordArrayish(data);
}

/**
 * Panels often return all streams in one JSON array; some cap near a fixed size. If the first
 * response has exactly `XTREAM_PAGE_SIZE` rows, request more with `offset` + `limit` until a
 * short page, empty page, or a page that adds no new `stream_id`s (offset ignored → duplicates).
 */
async function fetchStreamsAllPages(
  cfg: XtreamCredentialsJson,
  action: "get_live_streams" | "get_vod_streams",
  categoryId?: string,
): Promise<Record<string, unknown>[]> {
  const ps = LIMITS.XTREAM_PAGE_SIZE;
  const rows = await fetchStreamsOnce(cfg, action, categoryId);
  if (rows.length === 0 || rows.length > ps) return rows;

  const seen = new Set<string>();
  for (const r of rows) {
    const id = streamIdFrom(r);
    if (id) seen.add(id);
  }
  const out = [...rows];
  let offset = rows.length;
  for (let p = 1; p < LIMITS.XTREAM_MAX_STREAM_PAGES_PER_CATEGORY; p++) {
    const more = await fetchStreamsOnce(cfg, action, categoryId, {
      limit: String(ps),
      offset: String(offset),
    });
    await sleep(LIMITS.XTREAM_REQUEST_GAP_MS);
    if (more.length === 0) break;
    let added = 0;
    for (const r of more) {
      const id = streamIdFrom(r);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      added++;
    }
    if (added === 0) break;
    if (more.length < ps) break;
    offset += more.length;
  }
  return out;
}

/**
 * Build an M3U document from Xtream Codes `player_api.php` (live + VOD). Series are omitted (episode structure differs).
 * Stops at `maxChannels` (or `MAX_CHANNELS_PER_PLAYLIST` when omitted) rows total.
 */
export async function fetchXtreamM3uText(
  cfg: XtreamCredentialsJson,
  opts?: FetchXtreamM3uOpts,
): Promise<string> {
  const { username, password } = cfg;
  const { server, liveExt } = await xtreamAuth(cfg);
  const baseRoot = streamBaseUrl(cfg.baseUrl, server);
  const rawMax =
    typeof opts?.maxChannels === "number" && Number.isFinite(opts.maxChannels)
      ? Math.floor(opts.maxChannels)
      : LIMITS.MAX_CHANNELS_PER_PLAYLIST;
  const max = Math.min(LIMITS.MAX_CHANNELS_PER_PLAYLIST, Math.max(0, rawMax));
  const channels: ChannelEntry[] = [];

  const report = (detail: string) => {
    opts?.onProgress?.({ built: channels.length, detail });
  };

  report("Xtream: loading categories…");
  const liveCat = await fetchCategoryMap(cfg, "get_live_categories");
  let bulkLive = await fetchStreamsAllPages(cfg, "get_live_streams").catch(() => []);

  const useBulkLive = bulkLive.length > 0;
  if (useBulkLive) {
    report("Xtream: loading live (bulk)…");
    let lastReported = 0;
    for (const row of bulkLive) {
      if (channels.length >= max) break;
      const sid = streamIdFrom(row);
      if (!sid) continue;
      const name = sanitizeTitle(String(row.name ?? "Live"));
      const catId = row.category_id != null ? String(row.category_id) : "";
      const groupTitle = catId && liveCat.has(catId) ? liveCat.get(catId)! : "Live TV";
      const icon = row.stream_icon != null ? String(row.stream_icon) : "";
      const epg = row.epg_channel_id != null ? String(row.epg_channel_id) : "";
      const u = `${baseRoot}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${sid}.${liveExt}`;
      channels.push({
        duration: "-1",
        title: name,
        url: u,
        attrString: "",
        tvgId: epg || undefined,
        tvgName: name,
        tvgLogo: icon || undefined,
        groupTitle,
      });
      if (channels.length - lastReported >= 4000) {
        lastReported = channels.length;
        report(`Xtream: live ${channels.length.toLocaleString()} channels…`);
      }
    }
    report(`Xtream: live done (${channels.length.toLocaleString()} rows)`);
  } else {
    report("Xtream: loading live by category…");
    let liveCatRequests = 0;
    for (const [cid] of liveCat) {
      if (channels.length >= max) break;
      if (liveCatRequests >= LIMITS.XTREAM_MAX_CATEGORY_REQUESTS) break;
      liveCatRequests++;
      const rows = await fetchStreamsAllPages(cfg, "get_live_streams", cid);
      await sleep(LIMITS.XTREAM_REQUEST_GAP_MS);
      const groupTitle = liveCat.get(cid) ?? "Live TV";
      for (const row of rows) {
        if (channels.length >= max) break;
        const sid = streamIdFrom(row);
        if (!sid) continue;
        const name = sanitizeTitle(String(row.name ?? "Live"));
        const icon = row.stream_icon != null ? String(row.stream_icon) : "";
        const epg = row.epg_channel_id != null ? String(row.epg_channel_id) : "";
        const u = `${baseRoot}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${sid}.${liveExt}`;
        channels.push({
          duration: "-1",
          title: name,
          url: u,
          attrString: "",
          tvgId: epg || undefined,
          tvgName: name,
          tvgLogo: icon || undefined,
          groupTitle,
        });
      }
      report(`Xtream: live · ${groupTitle.slice(0, 80)}${groupTitle.length > 80 ? "…" : ""} (${channels.length.toLocaleString()} total)`);
    }
  }

  if (channels.length < max) {
    report("Xtream: loading VOD…");
    const vodCat = await fetchCategoryMap(cfg, "get_vod_categories");
    let vodCatRequests = 0;
    for (const [cid, cname] of vodCat) {
      if (channels.length >= max) break;
      if (vodCatRequests >= LIMITS.XTREAM_MAX_CATEGORY_REQUESTS) break;
      vodCatRequests++;
      const rows = await fetchStreamsAllPages(cfg, "get_vod_streams", cid);
      await sleep(LIMITS.XTREAM_REQUEST_GAP_MS);
      const groupTitle = `VOD|${cname}`;
      for (const row of rows) {
        if (channels.length >= max) break;
        const sid = streamIdFrom(row);
        if (!sid) continue;
        const name = sanitizeTitle(String(row.name ?? "Movie"));
        const icon = row.stream_icon != null ? String(row.stream_icon) : "";
        const ext = String(row.container_extension ?? "mp4").replace(/^\./, "") || "mp4";
        const u = `${baseRoot}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${sid}.${ext}`;
        channels.push({
          duration: "-1",
          title: name,
          url: u,
          attrString: "",
          tvgName: name,
          tvgLogo: icon || undefined,
          groupTitle,
        });
      }
      report(`Xtream: VOD · ${cname.slice(0, 72)}${cname.length > 72 ? "…" : ""} (${channels.length.toLocaleString()} total)`);
    }
  }

  if (channels.length === 0) {
    throw new Error(
      "Xtream source returned no live or VOD streams (empty catalog or unsupported panel response).",
    );
  }

  const body = serializeM3u(channels);
  if (Buffer.byteLength(body, "utf8") > LIMITS.MAX_M3U_BYTES) {
    throw new Error("Generated Xtream M3U exceeds size limit");
  }
  return body;
}
