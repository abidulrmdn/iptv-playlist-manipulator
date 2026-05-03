/** Mirrors `hashEditorFilterKey` in `functions/src/editorHydration.ts` (SHA-256 hex, first 20 chars). */
export async function hashEditorFilterKey(
  dataSet: "player" | "rulesDropped",
  tabFilter: string,
  searchNeedle: string,
): Promise<string> {
  const raw = `${dataSet}|${tabFilter}|${searchNeedle}`;
  const enc = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 20);
}
