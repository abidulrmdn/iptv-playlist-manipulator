/** Shared with the web organizer: exact-title exclude patterns, chunked for regex engine limits. */
export const EXCLUDE_NAME_TITLE_CHUNK_SIZE = 80;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds `^(?:a|b|c)$` style patterns from channel titles (may contain duplicates).
 * @throws if a chunk produces an invalid `RegExp`
 */
export function buildExcludeNamePatternsFromTitles(titles: string[]): string[] {
  const patterns: string[] = [];
  for (let i = 0; i < titles.length; i += EXCLUDE_NAME_TITLE_CHUNK_SIZE) {
    const chunk = [...new Set(titles.slice(i, i + EXCLUDE_NAME_TITLE_CHUNK_SIZE).map((t) => t.trim()).filter(Boolean))];
    if (chunk.length === 0) continue;
    const inner = chunk.map((t) => escapeRegExp(t)).join("|");
    const pattern = `^(?:${inner})$`;
    try {
      void new RegExp(pattern);
    } catch {
      throw new Error("Could not compile name-exclude pattern for this chunk");
    }
    patterns.push(pattern);
  }
  return patterns;
}
