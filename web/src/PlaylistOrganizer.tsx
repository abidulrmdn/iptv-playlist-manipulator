import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { auth, callable } from "./firebase";

type EditorTab = "tv" | "movie" | "series";

type EditorRow = {
  id: string;
  title: string;
  groupTitle: string;
  url: string;
  tvgLogo?: string;
  tvgName?: string;
  tab: EditorTab;
};

type PlaylistRules = {
  dedupe: boolean;
  dedupeBy: "url" | "name";
  includeGroupPatterns: string[];
  excludeGroupPatterns: string[];
  includeNamePatterns: string[];
  excludeNamePatterns: string[];
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
  groupRenames: { pattern: string; replacement: string }[];
  groupOrder: string[];
  latestGroupName: string;
  newMarkerPrefix: string;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const fe = e as Error & { code?: string; details?: unknown };
    if (fe.code === "functions/deadline-exceeded") {
      return "That operation timed out. Try again with a smaller page or fewer sources.";
    }
    const m = fe.message?.trim();
    if (m && !/^internal$/i.test(m) && m !== "deadline-exceeded") return m;
    if (typeof fe.details === "string" && fe.details.trim()) return fe.details.trim();
    if (fe.code?.startsWith("functions/")) return fe.code.replace(/^functions\//, "").replace(/-/g, " ");
    return m || "Something went wrong";
  }
  return "Something went wrong";
}

function suggestPattern(field: "name" | "group" | "url", row: EditorRow): string {
  const raw = field === "name" ? row.title : field === "group" ? row.groupTitle : row.url;
  const trimmed = raw.trim();
  if (!trimmed) return ".*";
  return `^${escapeRegExp(trimmed)}$`;
}

export function PlaylistOrganizer() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const loadedThroughRef = useRef(0);
  const [enrichEnabled, setEnrichEnabled] = useState(false);
  const [dupLatest, setDupLatest] = useState(true);
  const [rules, setRules] = useState<PlaylistRules | null>(null);

  const [tab, setTab] = useState<EditorTab | "all">("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [menu, setMenu] = useState<{ x: number; y: number; row: EditorRow } | null>(null);
  const [filterModal, setFilterModal] = useState<{
    row: EditorRow;
    field: "name" | "group" | "url";
    pattern: string;
    mode: "include" | "exclude";
  } | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4800);
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      if (!playlistId || !user) return;
      if (reset) loadedThroughRef.current = 0;
      setBusy(true);
      try {
        const off = reset ? 0 : loadedThroughRef.current;
        const fn = callable<
          { playlistId: string; offset?: number; limit?: number },
          {
            name: string;
            rules: PlaylistRules;
            channels: EditorRow[];
            total: number;
            offset: number;
            limit: number;
            hasMore: boolean;
            enrichEnabled: boolean;
            duplicateNewIntoLatest: boolean;
          }
        >("getPlaylistEditorData", { timeout: 120_000 });
        const r = await fn({ playlistId, offset: off, limit: 1500 });
        const d = r.data;
        setName(d.name);
        setRules(d.rules);
        setEnrichEnabled(Boolean(d.enrichEnabled));
        setDupLatest(d.duplicateNewIntoLatest !== false);
        setTotal(d.total);
        setHasMore(d.hasMore);
        loadedThroughRef.current = d.offset + d.channels.length;
        setRows((prev) => {
          if (reset) return d.channels;
          const seen = new Set(prev.map((x) => x.id));
          const add = d.channels.filter((c) => !seen.has(c.id));
          return [...prev, ...add];
        });
      } catch (e) {
        notify(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [playlistId, user, notify],
  );

  useEffect(() => {
    if (user && playlistId) void load(true);
  }, [user, playlistId, load]);

  const tabCounts = useMemo(() => {
    const c = { tv: 0, movie: 0, series: 0 };
    for (const r of rows) c[r.tab]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "all" && r.tab !== tab) return false;
      if (!qq) return true;
      return (
        r.title.toLowerCase().includes(qq) ||
        r.groupTitle.toLowerCase().includes(qq) ||
        r.url.toLowerCase().includes(qq)
      );
    });
  }, [rows, tab, q]);

  const toggleSel = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(visible.map((r) => r.id)));
  };

  const clearSel = () => setSelected(new Set());

  const saveRules = async () => {
    if (!playlistId || !rules) return;
    setBusy(true);
    try {
      const u = callable<
        { id: string; rules: PlaylistRules; enrichEnabled: boolean; duplicateNewIntoLatest: boolean },
        { ok: boolean }
      >("updatePlaylist");
      await u({ id: playlistId, rules, enrichEnabled, duplicateNewIntoLatest: dupLatest });
      notify("Rules saved — run Fetch & rebuild M3U on the main page to apply to the player file.");
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openFilterLike = (row: EditorRow, field: "name" | "group" | "url") => {
    setMenu(null);
    setFilterModal({
      row,
      field,
      pattern: suggestPattern(field, row),
      mode: "exclude",
    });
  };

  const applyFilterModal = () => {
    if (!filterModal || !rules) return;
    const { pattern, mode, field } = filterModal;
    try {
      void new RegExp(pattern);
    } catch {
      notify("Invalid regex");
      return;
    }
    const key =
      field === "name"
        ? mode === "exclude"
          ? "excludeNamePatterns"
          : "includeNamePatterns"
        : field === "group"
          ? mode === "exclude"
            ? "excludeGroupPatterns"
            : "includeGroupPatterns"
          : mode === "exclude"
            ? "excludeUrlPatterns"
            : "includeUrlPatterns";
    const arr = [...rules[key]];
    if (!arr.includes(pattern)) arr.push(pattern);
    setRules({ ...rules, [key]: arr });
    setFilterModal(null);
    notify(`Added ${mode} pattern on ${field}. Save rules when done.`);
  };

  const bulkExcludeSelectedByName = () => {
    if (!rules) return;
    const pick = rows.filter((r) => selected.has(r.id)).slice(0, 24);
    if (pick.length === 0) {
      notify("Select at least one row");
      return;
    }
    const inner = pick.map((r) => escapeRegExp(r.title.trim())).join("|");
    const pattern = `^(?:${inner})$`;
    try {
      void new RegExp(pattern);
    } catch {
      notify("Could not build a combined regex from those titles — try fewer rows.");
      return;
    }
    const arr = [...rules.excludeNamePatterns];
    if (!arr.includes(pattern)) arr.push(pattern);
    setRules({ ...rules, excludeNamePatterns: arr });
    clearSel();
    notify(`Added bulk exclude-by-name pattern (${pick.length} titles). Save rules when done.`);
  };

  const previewMatches = useMemo(() => {
    if (!filterModal) return [];
    let re: RegExp;
    try {
      re = new RegExp(filterModal.pattern, "i");
    } catch {
      return [];
    }
    const field = filterModal.field;
    return visible.filter((r) => {
      const v = field === "name" ? r.title : field === "group" ? r.groupTitle : r.url;
      return re.test(v);
    });
  }, [filterModal, visible]);

  if (!playlistId) {
    return <p className="p-8 text-zinc-400">Missing playlist id.</p>;
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-8">
        <p className="text-zinc-400">
          Sign in from the{" "}
          <Link className="text-emerald-400 underline" to="/">
            home page
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Playlist organizer · Phase 1</p>
            <h1 className="font-display text-xl font-semibold text-white">{name || "Playlist"}</h1>
            <p className="text-xs text-zinc-500">
              Tabs use heuristics plus <span className="text-zinc-400">TMDB(movie|tv):</span> tags when enrichment ran.
              Patterns apply on the next <strong className="font-normal text-zinc-300">Fetch & rebuild M3U</strong>.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800" to="/">
              Main app
            </Link>
            <button
              type="button"
              disabled={busy || !rules}
              onClick={() => void saveRules()}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
            >
              Save rules
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(true)}
              className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
            >
              Reload data
            </button>
            <button type="button" onClick={() => void signOut(auth)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          {(["all", "tv", "movie", "series"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t ? "bg-emerald-500 text-emerald-950" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {t === "all" ? `All (${total})` : t === "tv" ? `TV (${tabCounts.tv})` : t === "movie" ? `Movies (${tabCounts.movie})` : `Series (${tabCounts.series})`}
            </button>
          ))}
          <span className="ml-auto text-xs text-zinc-500">
            Loaded {rows.length} / {total} rows
            {enrichEnabled ? " · enrichment on" : ""}
          </span>
        </div>

        <div className="flex flex-wrap gap-6 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-300">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={enrichEnabled} onChange={(e) => setEnrichEnabled(e.target.checked)} />
            TMDB enrichment (next rebuild)
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={dupLatest} onChange={(e) => setDupLatest(e.target.checked)} />
            Duplicate new into Latest
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[200px]">
            <span className="text-xs font-medium uppercase text-zinc-500">Search loaded rows</span>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Title, group, or URL…"
            />
          </label>
          <button type="button" onClick={selectAllVisible} className="rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">
            Select visible
          </button>
          <button type="button" onClick={clearSel} className="rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">
            Clear selection
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={bulkExcludeSelectedByName}
            className="rounded-lg border border-amber-800/60 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
          >
            Bulk exclude by name (≤24)
          </button>
          {hasMore && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(false)}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              Load more
            </button>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/80 text-xs uppercase text-zinc-500">
              <tr>
                <th className="w-10 px-2 py-2" />
                <th className="px-2 py-2">Title</th>
                <th className="px-2 py-2">Group</th>
                <th className="hidden px-2 py-2 lg:table-cell">URL</th>
                <th className="w-20 px-2 py-2">Tab</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-zinc-800/80 hover:bg-zinc-800/40 ${selected.has(r.id) ? "bg-emerald-500/5" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, row: r });
                  }}
                >
                  <td className="px-2 py-2 align-top">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} />
                  </td>
                  <td className="max-w-md px-2 py-2 align-top">
                    <div className="line-clamp-2 break-words text-zinc-200">{r.title}</div>
                    {r.tvgName && <div className="mt-0.5 text-xs text-zinc-500">{r.tvgName}</div>}
                  </td>
                  <td className="max-w-[180px] px-2 py-2 align-top text-zinc-400">{r.groupTitle}</td>
                  <td className="hidden max-w-lg px-2 py-2 align-top font-mono text-[11px] text-zinc-500 lg:table-cell">
                    <div className="line-clamp-2 break-all">{r.url}</div>
                  </td>
                  <td className="px-2 py-2 align-top text-xs uppercase text-zinc-500">{r.tab}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && !busy && <p className="p-8 text-center text-sm text-zinc-500">No rows match this tab or search.</p>}
        </div>

        <p className="text-xs text-zinc-600">
          Phase 2: virtualization & full-list regex preview. Phase 3: per-channel pull-to-top. Right-click a row for
          “Filter like this…”.
        </p>
      </div>

      {menu && (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default bg-black/40" aria-label="Close menu" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 min-w-[200px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <p className="border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">Filter like this</p>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800" onClick={() => openFilterLike(menu.row, "name")}>
              By channel title…
            </button>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800" onClick={() => openFilterLike(menu.row, "group")}>
              By group name…
            </button>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800" onClick={() => openFilterLike(menu.row, "url")}>
              By stream URL…
            </button>
          </div>
        </>
      )}

      {filterModal && rules && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 className="text-lg font-semibold text-white">Filter like this</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Suggested regex (edit if needed). Preview matches among <strong className="font-normal text-zinc-300">visible / loaded</strong> rows
                only; after Save rules, the pattern applies to the full playlist on the next rebuild.
              </p>
            </div>
            <div className="space-y-3 px-5 py-4">
              <label className="block text-xs font-medium uppercase text-zinc-500">Field</label>
              <p className="text-sm text-zinc-300">{filterModal.field}</p>
              <label className="block text-xs font-medium uppercase text-zinc-500">Regex</label>
              <textarea
                className="h-20 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-200"
                value={filterModal.pattern}
                onChange={(e) => setFilterModal({ ...filterModal, pattern: e.target.value })}
              />
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mode"
                    checked={filterModal.mode === "exclude"}
                    onChange={() => setFilterModal({ ...filterModal, mode: "exclude" })}
                  />
                  Exclude (hide matching)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mode"
                    checked={filterModal.mode === "include"}
                    onChange={() => setFilterModal({ ...filterModal, mode: "include" })}
                  />
                  Include (keep only matching — adds include pattern)
                </label>
              </div>
              <p className="text-xs text-zinc-500">
                Matches in current view: <span className="text-emerald-300">{previewMatches.length}</span>
              </p>
              <div className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
                {previewMatches.slice(0, 80).map((r) => (
                  <div key={r.id} className="truncate border-b border-zinc-800/60 py-1 last:border-0">
                    {r.title}
                  </div>
                ))}
                {previewMatches.length > 80 && <p className="py-2 text-zinc-600">…and {previewMatches.length - 80} more</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
              <button type="button" className="rounded-lg border border-zinc-600 px-4 py-2 text-sm" onClick={() => setFilterModal(null)}>
                Cancel
              </button>
              <button type="button" className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950" onClick={applyFilterModal}>
                Add to rules
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
