import { createHash } from "crypto";

export type ChannelEntry = {
  duration: string;
  title: string;
  url: string;
  /** Raw attribute string between duration and title comma (trimmed), excluding leading spaces after duration. */
  attrString: string;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  groupTitle?: string;
  urlTvg?: string;
  /** Optional #EXTGRP from some playlists */
  extgrp?: string;
};

function parseAttrString(attrPart: string): Partial<Pick<ChannelEntry, "tvgId" | "tvgName" | "tvgLogo" | "groupTitle" | "urlTvg">> {
  const out: Partial<ChannelEntry> = {};
  const re = /([A-Za-z0-9._-]+)="((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrPart))) {
    const k = m[1];
    const v = m[2].replace(/\\"/g, '"');
    if (k === "tvg-id") out.tvgId = v;
    else if (k === "tvg-name") out.tvgName = v;
    else if (k === "tvg-logo") out.tvgLogo = v;
    else if (k === "group-title") out.groupTitle = v;
    else if (k === "url-tvg") out.urlTvg = v;
  }
  return out;
}

function splitExtinf(line: string): { duration: string; attrPart: string; title: string } | null {
  if (!line.startsWith("#EXTINF:")) return null;
  const body = line.slice("#EXTINF:".length);
  let quote = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') quote = !quote;
    if (c === "," && !quote) {
      const left = body.slice(0, i).trim();
      const title = body.slice(i + 1).trim();
      const durMatch = left.match(/^(-?\d+)\s*(.*)$/);
      if (!durMatch) return null;
      return { duration: durMatch[1], attrPart: durMatch[2].trim(), title };
    }
  }
  return null;
}

/**
 * Parse M3U text into channel entries. Handles #EXTGRP before EXTINF blocks.
 */
export function parseM3u(text: string): ChannelEntry[] {
  return [...iterateM3uChannels(text)];
}

/**
 * Stream-parse M3U without building a full in-memory array (for large playlists).
 */
export function forEachM3uChannel(text: string, fn: (ch: ChannelEntry) => void): void {
  for (const ch of iterateM3uChannels(text)) fn(ch);
}

/** Memory-friendly iterator for large playlists (hydration / streaming). */
export function* iterateM3uChannels(text: string): Generator<ChannelEntry> {
  const lines = text.split(/\r?\n/);
  let pendingExtinf: string | null = null;
  let currentExtgrp: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTGRP:")) {
      currentExtgrp = line.slice("#EXTGRP:".length).trim();
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingExtinf = line;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pendingExtinf) {
      const parts = splitExtinf(pendingExtinf);
      if (parts) {
        const attrs = parseAttrString(parts.attrPart);
        const groupTitle = attrs.groupTitle ?? currentExtgrp;
        yield {
          duration: parts.duration,
          title: parts.title,
          url: line,
          attrString: parts.attrPart,
          tvgId: attrs.tvgId,
          tvgName: attrs.tvgName,
          tvgLogo: attrs.tvgLogo,
          groupTitle,
          urlTvg: attrs.urlTvg,
          extgrp: currentExtgrp,
        };
      }
      pendingExtinf = null;
    }
  }
}

function escapeAttrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function rebuildExtinf(ch: ChannelEntry): string {
  const attrs = parseAttrString(ch.attrString);
  const merged: Record<string, string | undefined> = {
    "tvg-id": ch.tvgId ?? attrs.tvgId,
    "tvg-name": ch.tvgName ?? attrs.tvgName,
    "tvg-logo": ch.tvgLogo ?? attrs.tvgLogo,
    "group-title": ch.groupTitle ?? attrs.groupTitle,
    "url-tvg": ch.urlTvg ?? attrs.urlTvg,
  };
  const order = ["tvg-id", "tvg-name", "tvg-logo", "group-title", "url-tvg"];
  const known = new Set(order);
  const parts: string[] = [];
  for (const k of order) {
    const v = merged[k];
    if (v !== undefined && v !== "") parts.push(`${k}="${escapeAttrValue(v)}"`);
  }
  const reUnknown = /([A-Za-z0-9._-]+)="((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = reUnknown.exec(ch.attrString))) {
    const k = m[1];
    if (known.has(k)) continue;
    parts.push(`${k}="${escapeAttrValue(m[2].replace(/\\"/g, '"'))}"`);
  }
  const attrJoined = parts.join(" ");
  return `#EXTINF:${ch.duration}${attrJoined ? " " + attrJoined : ""},${ch.title}`;
}

export function serializeM3u(entries: ChannelEntry[]): string {
  const lines = ["#EXTM3U"];
  for (const ch of entries) {
    lines.push(rebuildExtinf(ch));
    lines.push(ch.url);
  }
  return lines.join("\n") + "\n";
}

export function canonicalId(ch: ChannelEntry): string {
  const normUrl = ch.url.trim();
  const h = createHash("sha256").update(normUrl).digest("hex").slice(0, 32);
  return `u:${h}`;
}
