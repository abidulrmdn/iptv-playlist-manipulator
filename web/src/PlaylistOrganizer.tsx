import { useVirtualizer } from "@tanstack/react-virtual";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, callable, db, publicPlaylistUrl } from "./firebase";
import { formatRefreshProgressLine, type PlaylistRefreshProgress } from "./refreshProgressFormat";
import { LIMITS, type PlaylistRules, type RulePatternTabScope } from "../../functions/src/constants";
import { escapeRegExp } from "../../functions/src/excludeNamePatternChunks";
import { applyRulesPreview, type PreviewChannel } from "./playlistRulesPreview";

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

type ContextMenuState = { x: number; y: number; row: EditorRow; scope: "group" | "channel"; groupKey: string };

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

type RowEntry = PreviewChannel & { __rowId: string };

function rowToPreviewEntry(r: EditorRow): RowEntry {
  return {
    duration: "-1",
    title: r.title,
    url: r.url,
    attrString: "",
    groupTitle: r.groupTitle,
    tvgLogo: r.tvgLogo,
    tvgName: r.tvgName,
    editorId: r.id,
    editorTab: r.tab,
    __rowId: r.id,
  };
}

function capChannelOrderList(order: string[]): string[] {
  const max = LIMITS.MAX_CHANNEL_ORDER_ENTRIES;
  if (order.length <= max) return order;
  return order.slice(0, max);
}

function DragGripIcon() {
  return (
    <svg width="11" height="17" viewBox="0 0 11 17" className="text-current" aria-hidden>
      <circle cx="2.75" cy="3" r="1.2" fill="currentColor" />
      <circle cx="8.25" cy="3" r="1.2" fill="currentColor" />
      <circle cx="2.75" cy="8.5" r="1.2" fill="currentColor" />
      <circle cx="8.25" cy="8.5" r="1.2" fill="currentColor" />
      <circle cx="2.75" cy="14" r="1.2" fill="currentColor" />
      <circle cx="8.25" cy="14" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** Group header checkbox: supports indeterminate when some channels in the group are selected. */
function GroupHeaderCheckbox({
  allSelected,
  someSelected,
  onChange,
}: {
  allSelected: boolean;
  someSelected: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  return <input ref={ref} type="checkbox" checked={allSelected} onChange={onChange} className="mt-0.5" />;
}

function TabPill({ tab }: { tab: EditorTab }) {
  const cls =
    tab === "tv"
      ? "border-emerald-800/50 bg-emerald-950/40 text-emerald-200"
      : tab === "movie"
        ? "border-amber-800/50 bg-amber-950/40 text-amber-200"
        : "border-sky-800/50 bg-sky-950/40 text-sky-200";
  return (
    <span className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {tab}
    </span>
  );
}

function ChannelThumb({ row }: { row: EditorRow }) {
  if (row.tvgLogo) {
    return (
      <img
        src={row.tvgLogo}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="h-11 w-11 shrink-0 rounded-lg border border-zinc-700/80 bg-zinc-950 object-cover"
      />
    );
  }
  return (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/90 text-xs font-bold uppercase text-zinc-500"
      aria-hidden
    >
      {row.tab === "tv" ? "TV" : row.tab === "movie" ? "M" : "S"}
    </div>
  );
}

/** Virtual row height hint; `measureElement` corrects per row after paint. */
const CHANNEL_ROW_ESTIMATE_PX = 96;

type VirtualGroupChannelListProps = {
  group: string;
  gRows: EditorRow[];
  selected: Set<string>;
  toggleSel: (id: string) => void;
  setMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  reorderChannelInGroup: (groupKey: string, fromId: string, toId: string) => void;
  dragChannelRef: MutableRefObject<{ groupKey: string; id: string } | null>;
  dragGroupRef: MutableRefObject<string | null>;
};

function VirtualGroupChannelList({
  group,
  gRows,
  selected,
  toggleSel,
  setMenu,
  reorderChannelInGroup,
  dragChannelRef,
  dragGroupRef,
}: VirtualGroupChannelListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: gRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CHANNEL_ROW_ESTIMATE_PX,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="max-h-[min(60vh,520px)] overflow-y-auto overflow-x-hidden">
      <ul className="relative w-full" role="list" style={{ height: gRows.length ? virtualizer.getTotalSize() : undefined }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const r = gRows[vi.index]!;
          return (
            <li
              key={r.id}
              role="listitem"
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className={`absolute left-0 top-0 box-border flex w-full max-w-full gap-3 border-b border-zinc-800/90 px-4 py-3 transition-colors hover:bg-zinc-800/25 ${
                selected.has(r.id) ? "bg-emerald-500/5 ring-1 ring-inset ring-emerald-500/25" : ""
              }`}
              style={{ transform: `translateY(${vi.start}px)` }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, row: r, scope: "channel", groupKey: group });
              }}
              onDragOver={(e) => {
                if (dragChannelRef.current?.groupKey === group) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const payload = dragChannelRef.current;
                dragChannelRef.current = null;
                if (!payload || payload.groupKey !== group || payload.id === r.id) return;
                reorderChannelInGroup(group, payload.id, r.id);
              }}
              onDragEnd={() => {
                dragChannelRef.current = null;
              }}
            >
              <div className="flex shrink-0 items-start gap-1 pt-0.5">
                <span
                  draggable
                  title="Drag to reorder within this group"
                  onDragStart={(ev) => {
                    ev.stopPropagation();
                    dragChannelRef.current = { groupKey: group, id: r.id };
                    dragGroupRef.current = null;
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", `ch:${r.id}`);
                  }}
                  onDragEnd={() => {
                    dragChannelRef.current = null;
                  }}
                  className="mt-0.5 inline-flex cursor-grab select-none rounded-md border border-transparent p-1 text-zinc-500 hover:border-zinc-600 hover:bg-zinc-800/50 hover:text-zinc-300 active:cursor-grabbing"
                >
                  <DragGripIcon />
                </span>
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleSel(r.id)}
                  className="mt-1"
                  aria-label={`Select ${r.title}`}
                />
              </div>
              <ChannelThumb row={r} />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm font-medium leading-snug text-zinc-100">{r.title}</div>
                {r.tvgName ? <div className="mt-0.5 line-clamp-1 text-xs text-zinc-500">{r.tvgName}</div> : null}
                <div className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-zinc-500 lg:text-xs">{r.url}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                <TabPill tab={r.tab} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type SimpleMatchKind = "exact" | "contains" | "starts" | "ends";

type FilterModalState = {
  row: EditorRow;
  field: "name" | "group" | "url";
  pattern: string;
  mode: "include" | "exclude";
  /** Simple = phrase + buttons; advanced = raw regex textarea. */
  patternEditor: "simple" | "advanced";
  simpleHow: SimpleMatchKind;
  /** Plain text the user edits in simple mode (escaped when building the pattern). */
  simplePhrase: string;
  /** Opened from “Add a rule” — no row context; user picks field and types text. */
  standalone: boolean;
};

/** Placeholder row for toolbar “Add a rule”; only `field` + `pattern` matter for saving. */
const STANDALONE_RULE_ANCHOR: EditorRow = {
  id: "__standalone__",
  title: "",
  groupTitle: "",
  url: "",
  tab: "tv",
};

function anchorRowForGroupContextMenu(gRows: EditorRow[], displayGroup: string): EditorRow | null {
  const first = gRows[0];
  if (!first) return null;
  return { ...first, groupTitle: displayGroup };
}

function rawFieldValue(field: "name" | "group" | "url", row: EditorRow): string {
  return field === "name" ? row.title : field === "group" ? row.groupTitle : row.url;
}

function patternFromSimplePhrase(how: SimpleMatchKind, phrase: string): string {
  const t = phrase.trim();
  if (!t) {
    if (how === "exact") return "^$";
    return "(?!)"; // matches nothing — user should type text for contains / starts / ends
  }
  const e = escapeRegExp(t);
  switch (how) {
    case "exact":
      return `^${e}$`;
    case "contains":
      return e;
    case "starts":
      return `^${e}`;
    case "ends":
      return `${e}$`;
  }
}

function fieldLabel(field: "name" | "group" | "url"): string {
  switch (field) {
    case "name":
      return "Channel title";
    case "group":
      return "Group name";
    case "url":
      return "Stream address";
  }
}

/** Organizer toolbar: shared button + cluster styles for a tighter control strip. */
const orgCluster = "inline-flex flex-wrap items-center gap-1 rounded-xl border border-zinc-800/90 bg-zinc-950/55 p-1 shadow-sm";
const orgBtn =
  "min-h-10 rounded-lg px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-800/90 disabled:pointer-events-none disabled:opacity-40 sm:min-h-0";
const orgBtnOutline = `${orgBtn} border border-zinc-600/60 hover:border-zinc-500`;
const orgBtnEmerald = `${orgBtn} border border-emerald-600/35 bg-emerald-500/12 font-medium text-emerald-100 hover:bg-emerald-500/22`;
const orgBtnAmber = `${orgBtn} border border-amber-700/45 bg-amber-950/35 text-amber-100 hover:bg-amber-950/55`;
const orgBtnSkyLine = `${orgBtn} border border-sky-700/45 bg-sky-950/25 text-sky-100 hover:bg-sky-950/45`;
const orgBtnSkySolid =
  "min-h-11 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500 disabled:pointer-events-none disabled:opacity-40 sm:min-h-0 sm:py-2";

const PLAYLIST_ORG_SIDEBAR_KEY = "playlistOrganizer.playlistSidebarOpen";

function InlineHelp({ text }: { text: string }) {
  return (
    <span
      className="ml-1 inline-flex h-5 w-5 shrink-0 cursor-help select-none items-center justify-center rounded-full border border-zinc-600 text-[10px] font-bold text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
      title={text}
      role="img"
      aria-label={text}
    >
      ?
    </span>
  );
}

type EditorDataSet = "player" | "rulesDropped";

const SIMPLE_MATCH_OPTIONS: { id: SimpleMatchKind; title: string; hint: string }[] = [
  {
    id: "exact",
    title: "Exactly this text",
    hint: "Same wording, full line — like picking this one channel or group.",
  },
  {
    id: "contains",
    title: "Contains this text",
    hint: "Matches if that wording appears anywhere inside the line.",
  },
  {
    id: "starts",
    title: "Starts with this text",
    hint: "The line must begin with what you typed.",
  },
  {
    id: "ends",
    title: "Ends with this text",
    hint: "The line must finish with what you typed.",
  },
];

export function PlaylistOrganizer() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [publicToken, setPublicToken] = useState("");
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const loadedThroughRef = useRef(0);
  const [enrichEnabled, setEnrichEnabled] = useState(false);
  const [dupLatest, setDupLatest] = useState(true);
  const [rules, setRules] = useState<PlaylistRules | null>(null);
  /** `player` = hosted M3U; `rulesDropped` = channels removed by rules on the last refresh (separate server file). */
  const [editorDataSet, setEditorDataSet] = useState<EditorDataSet>("player");

  const [tab, setTab] = useState<EditorTab | "all">("all");
  const [q, setQ] = useState("");
  /** Debounced substring sent to `getPlaylistEditorData` (server-side filter). */
  const [serverQuery, setServerQuery] = useState("");
  const [totalsByTab, setTotalsByTab] = useState<{
    all: number;
    tv: number;
    movie: number;
    series: number;
  } | null>(null);
  const editorFetchGen = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const dragGroupRef = useRef<string | null>(null);
  const dragChannelRef = useRef<{ groupKey: string; id: string } | null>(null);
  /** When rules hide rows, toggles between “included only” and “excluded only” among loaded rows. */
  const [showExcluded, setShowExcluded] = useState(false);
  const [filterModal, setFilterModal] = useState<FilterModalState | null>(null);
  /** Group names whose channel list is expanded; omitted groups stay collapsed (default). */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const skipNextRulesAutosave = useRef(false);
  const rulesAutosaveToken = useRef(0);
  /** Bumped before server-authoritative rule writes / reloads so debounced `updatePlaylist` cannot overwrite with stale rules. */
  const rulesSaveGeneration = useRef(0);
  const [rulesAutosaveState, setRulesAutosaveState] = useState<"idle" | "saving" | "saved">("idle");

  const [playlistSidebarOpen, setPlaylistSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const stored = window.localStorage.getItem(PLAYLIST_ORG_SIDEBAR_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
      /** First visit: keep main canvas wide on phones; desktop defaults to open. */
      return !window.matchMedia("(max-width: 767px)").matches;
    } catch {
      return true;
    }
  });

  const togglePlaylistSidebar = useCallback(() => {
    setPlaylistSidebarOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(PLAYLIST_ORG_SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4800);
  }, []);

  const [refreshProgress, setRefreshProgress] = useState<PlaylistRefreshProgress | null>(null);

  useEffect(() => {
    if (!playlistId || !user) {
      setRefreshProgress(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "playlists", playlistId),
      (snap) => {
        if (!snap.exists()) {
          setRefreshProgress(null);
          return;
        }
        const rp = snap.data()?.refreshProgress as unknown;
        if (rp && typeof rp === "object" && rp !== null && "channelsSoFar" in rp) {
          setRefreshProgress(rp as PlaylistRefreshProgress);
        } else {
          setRefreshProgress(null);
        }
      },
      () => setRefreshProgress(null),
    );
    return () => unsub();
  }, [playlistId, user]);

  useEffect(() => {
    const next = q.trim().slice(0, LIMITS.MAX_EDITOR_SEARCH_CHARS);
    if (next === serverQuery) return;
    const delay = next.length === 0 ? 0 : 320;
    const t = window.setTimeout(() => setServerQuery(next), delay);
    return () => window.clearTimeout(t);
  }, [q, serverQuery]);

  /** Fetches one page from offset 0 for the current tab/search/source, then shows it (no silent background paging). */
  const load = useCallback(async () => {
    if (!playlistId || !user) return;
    loadedThroughRef.current = 0;
    editorFetchGen.current += 1;
    const session = editorFetchGen.current;
    setBusy(true);
    try {
      rulesSaveGeneration.current += 1;
      const fn = callable<
        {
          playlistId: string;
          offset?: number;
          limit?: number;
          dataSet?: string;
          search?: string;
          tab?: string;
        },
        {
          name: string;
          publicToken: string;
          rules: PlaylistRules;
          channels: EditorRow[];
          total: number;
          offset: number;
          limit: number;
          hasMore: boolean;
          enrichEnabled: boolean;
          duplicateNewIntoLatest: boolean;
          dataSet?: string;
          rulesDroppedAvailable?: boolean;
          totalsByTab?: { all: number; tv: number; movie: number; series: number };
        }
      >("getPlaylistEditorData", { timeout: 120_000 });
      const r = await fn({
        playlistId,
        offset: 0,
        limit: LIMITS.MAX_EDITOR_PAGE_SIZE,
        dataSet: editorDataSet === "rulesDropped" ? "rulesDropped" : "player",
        ...(serverQuery ? { search: serverQuery } : {}),
        ...(tab !== "all" ? { tab } : {}),
      });
      if (session !== editorFetchGen.current) return;
      const d = r.data;
      skipNextRulesAutosave.current = true;
      setName(d.name);
      setPublicToken(d.publicToken ?? "");
      setRules(d.rules);
      setEnrichEnabled(Boolean(d.enrichEnabled));
      setDupLatest(d.duplicateNewIntoLatest !== false);
      setTotal(d.total);
      setHasMore(d.hasMore);
      if (d.totalsByTab) setTotalsByTab(d.totalsByTab);
      loadedThroughRef.current = d.offset + d.channels.length;
      startTransition(() => {
        setRows(d.channels);
      });
    } catch (e) {
      notify(errMsg(e));
    } finally {
      if (session === editorFetchGen.current) setBusy(false);
    }
  }, [playlistId, user, notify, editorDataSet, serverQuery, tab]);

  /** Fetches every remaining page from the current offset until the server reports no more rows. */
  const loadAllRemaining = useCallback(async () => {
    if (!playlistId || !user) return;
    editorFetchGen.current += 1;
    const snapshotGen = editorFetchGen.current;
    setBusy(true);
    const maxPages = Math.ceil(LIMITS.MAX_CHANNELS_PER_PLAYLIST / LIMITS.MAX_EDITOR_PAGE_SIZE) + 2;
    try {
      rulesSaveGeneration.current += 1;
      const ds = editorDataSet === "rulesDropped" ? "rulesDropped" : "player";
      const fn = callable<
        {
          playlistId: string;
          offset?: number;
          limit?: number;
          dataSet?: string;
          search?: string;
          tab?: string;
        },
        {
          name: string;
          publicToken: string;
          rules: PlaylistRules;
          channels: EditorRow[];
          total: number;
          offset: number;
          limit: number;
          hasMore: boolean;
          enrichEnabled: boolean;
          duplicateNewIntoLatest: boolean;
          dataSet?: string;
          rulesDroppedAvailable?: boolean;
          totalsByTab?: { all: number; tv: number; movie: number; series: number };
        }
      >("getPlaylistEditorData", { timeout: 120_000 });

      let off = loadedThroughRef.current;
      let pages = 0;
      let lastTotal = 0;

      while (pages < maxPages) {
        if (editorFetchGen.current !== snapshotGen) return;
        const r = await fn({
          playlistId,
          offset: off,
          limit: LIMITS.MAX_EDITOR_PAGE_SIZE,
          dataSet: ds,
          ...(serverQuery ? { search: serverQuery } : {}),
          ...(tab !== "all" ? { tab } : {}),
        });
        const d = r.data;
        pages += 1;
        lastTotal = d.total;
        if (editorFetchGen.current !== snapshotGen) return;
        skipNextRulesAutosave.current = true;
        setName(d.name);
        setPublicToken(d.publicToken ?? "");
        setRules(d.rules);
        setEnrichEnabled(Boolean(d.enrichEnabled));
        setDupLatest(d.duplicateNewIntoLatest !== false);
        setTotal(d.total);
        setHasMore(d.hasMore);
        if (d.totalsByTab) setTotalsByTab(d.totalsByTab);
        const nextOff = d.offset + d.channels.length;
        loadedThroughRef.current = nextOff;
        startTransition(() => {
          setRows((prev) => {
            const seen = new Set(prev.map((x) => x.id));
            const add = d.channels.filter((c) => !seen.has(c.id));
            return [...prev, ...add];
          });
        });
        off = nextOff;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        if (!d.hasMore) break;
        if (d.channels.length === 0) break;
      }

      if (editorFetchGen.current !== snapshotGen) return;
      if (pages >= maxPages) {
        notify("Stopped after safety cap — try reloading or contact support if the playlist is huge.");
      } else {
        notify(`Finished loading the table (${lastTotal.toLocaleString()} channels).`);
      }
    } catch (e) {
      notify(errMsg(e));
    } finally {
      if (editorFetchGen.current === snapshotGen) setBusy(false);
    }
  }, [playlistId, user, notify, editorDataSet, serverQuery, tab]);

  useEffect(() => {
    if (user && playlistId) void load();
  }, [user, playlistId, load]);

  const { tableSourceRows, excludedCount } = useMemo(() => {
    if (editorDataSet === "rulesDropped") {
      return { tableSourceRows: rows, excludedCount: 0 };
    }
    if (!rules || rows.length === 0) {
      return { tableSourceRows: rows, excludedCount: 0 };
    }
    const keptRows = applyRulesPreview(rows.map(rowToPreviewEntry), rules);
    const keptIds = new Set(keptRows.map((e) => (e as RowEntry).__rowId));
    const excluded = rows.filter((r) => !keptIds.has(r.id));
    const excludedCount = excluded.length;
    const tableSourceRows = showExcluded ? excluded : rows.filter((r) => keptIds.has(r.id));
    return { tableSourceRows, excludedCount };
  }, [rows, rules, showExcluded, editorDataSet]);

  useEffect(() => {
    setSelected(new Set());
    setShowExcluded(false);
  }, [editorDataSet]);

  useEffect(() => {
    if (excludedCount === 0) setShowExcluded(false);
  }, [excludedCount]);

  /** Rows already filtered by category + search on the server; rules preview applied client-side. */
  const visible = tableSourceRows;

  /** “Exclude selected” always runs on the server over the full generated M3U (not only loaded table rows). */
  const excludeSelectedStats = useMemo(
    () => ({ selectedTotal: selected.size, serverTotalChannels: total }),
    [selected, total],
  );

  const excludeSelectedButtonTitle = useMemo(() => {
    const s = excludeSelectedStats;
    if (s.selectedTotal === 0) {
      return "Select channels, then add exact-title exclude rules from the full playlist file on the server.";
    }
    return `Runs on the server against the full generated playlist (${s.serverTotalChannels.toLocaleString()} channels) for your ${s.selectedTotal.toLocaleString()} selected channel id(s) — not limited to rows loaded in this table.`;
  }, [excludeSelectedStats]);

  /** Visible rows grouped by `group-title` (same order as rules `groupOrder`, then A–Z). */
  const groupedVisible = useMemo(() => {
    const map = new Map<string, EditorRow[]>();
    for (const r of visible) {
      const g = r.groupTitle?.trim() || "Uncategorized";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    }
    const order = rules?.groupOrder ?? [];
    const rank = new Map(order.map((name, i) => [name, i]));
    const keys = [...map.keys()].sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a)! : 1_000_000;
      const rb = rank.has(b) ? rank.get(b)! : 1_000_000;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
    const chanRank = new Map((rules?.channelOrder ?? []).map((id, i) => [id, i]));
    return keys.map((group) => {
      const rows = map.get(group)!;
      rows.sort((a, b) => {
        const oa = chanRank.has(a.id) ? chanRank.get(a.id)! : 1_000_000;
        const ob = chanRank.has(b.id) ? chanRank.get(b.id)! : 1_000_000;
        if (oa !== ob) return oa - ob;
        return a.title.localeCompare(b.title);
      });
      return { group, rows };
    });
  }, [visible, rules?.groupOrder, rules?.channelOrder]);

  const visibleGroupNames = useMemo(() => new Set(groupedVisible.map((g) => g.group)), [groupedVisible]);

  useEffect(() => {
    setExpandedGroups((prev) => {
      let pruned = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (visibleGroupNames.has(k)) next.add(k);
        else pruned = true;
      }
      return pruned ? next : prev;
    });
  }, [visibleGroupNames]);

  const toggleGroupCollapsed = (group: string) => {
    setExpandedGroups((prev) => {
      const n = new Set(prev);
      if (n.has(group)) n.delete(group);
      else n.add(group);
      return n;
    });
  };

  const collapseAllGroups = () => {
    setExpandedGroups(new Set());
  };

  const expandAllGroups = () => setExpandedGroups(new Set(groupedVisible.map((g) => g.group)));

  const reorderChannelInGroup = useCallback(
    (groupKey: string, fromId: string, toId: string) => {
      if (!rules) return;
      const gv = groupedVisible.find((x) => x.group === groupKey);
      if (!gv) return;
      const ids = gv.rows.map((r) => r.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;
      const next = [...ids];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      const set = new Set(next);
      const rest = (rules.channelOrder ?? []).filter((id) => !set.has(id));
      const merged = capChannelOrderList([...next, ...rest]);
      setRules({ ...rules, channelOrder: merged });
      notify("Channel order updated — refresh the player file when you want the hosted M3U to match.");
    },
    [rules, groupedVisible, notify],
  );

  const reorderGroupsAfterDrag = useCallback(
    (from: string, to: string) => {
      if (!rules || from === to) return;
      const keys = groupedVisible.map((g) => g.group);
      const i = keys.indexOf(from);
      const j = keys.indexOf(to);
      if (i < 0 || j < 0) return;
      const next = [...keys];
      const [g] = next.splice(i, 1);
      next.splice(j, 0, g);
      const vis = new Set(next);
      const tail = rules.groupOrder.filter((name) => !vis.has(name));
      setRules({ ...rules, groupOrder: [...next, ...tail] });
      notify("Group order updated — refresh the player file when you want the hosted M3U to match.");
    },
    [rules, groupedVisible, notify],
  );

  const moveGroupToTopFromMenu = useCallback(() => {
    if (!menu || !rules) return;
    const g = menu.groupKey;
    setRules({ ...rules, groupOrder: [g, ...rules.groupOrder.filter((x) => x !== g)] });
    setMenu(null);
    notify("Group moved to top — refresh the player file when you want the hosted M3U to match.");
  }, [menu, rules, notify]);

  const moveChannelToTopFromMenu = useCallback(() => {
    if (!menu || !rules || menu.scope !== "channel") return;
    const multi = selected.size > 1 && selected.has(menu.row.id);
    let headIds: string[];
    if (multi) {
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const { rows: gr } of groupedVisible) {
        for (const row of gr) {
          if (selected.has(row.id) && !seen.has(row.id)) {
            seen.add(row.id);
            ordered.push(row.id);
          }
        }
      }
      for (const id of selected) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
      headIds = ordered;
    } else {
      headIds = [menu.row.id];
    }
    const headSet = new Set(headIds);
    const rest = (rules.channelOrder ?? []).filter((x) => !headSet.has(x));
    const merged = capChannelOrderList([...headIds, ...rest]);
    setRules({ ...rules, channelOrder: merged });
    setMenu(null);
    notify(
      multi
        ? `Moved ${headIds.length.toLocaleString()} channels to the top of each group — refresh the player file when you want the hosted M3U to match.`
        : "Channel moved to top of its group — refresh the player file when you want the hosted M3U to match.",
    );
  }, [menu, rules, notify, selected, groupedVisible]);

  const toggleGroupRows = (gRows: EditorRow[]) => {
    const ids = gRows.map((r) => r.id);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const n = new Set(prev);
      if (allOn) for (const id of ids) n.delete(id);
      else for (const id of ids) n.add(id);
      return n;
    });
  };

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

  const selectEntirePlaylist = async () => {
    if (!playlistId) return;
    setBusy(true);
    try {
      const fn = callable<{ playlistId: string }, { total: number; ids: string[] }>("getPlaylistEditorChannelIds", {
        timeout: 120_000,
      });
      const r = await fn({ playlistId });
      setSelected(new Set(r.data.ids));
      notify(`Selected all ${r.data.total.toLocaleString()} channels (full server list).`);
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const clearSel = () => setSelected(new Set());

  const rebuildM3u = async () => {
    if (!playlistId) return;
    setBusy(true);
    try {
      rulesSaveGeneration.current += 1;
      const fn = callable<{ playlistId: string }, { ok: boolean; channelCount: number }>("refreshPlaylist", {
        timeout: 600_000,
      });
      await fn({ playlistId });
      notify("Player file updated — reloading this table from the server…");
      await load();
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!playlistId || !user || !rules) return;
    if (skipNextRulesAutosave.current) {
      skipNextRulesAutosave.current = false;
      return;
    }
    const scheduledGen = rulesSaveGeneration.current;
    const t = window.setTimeout(() => {
      if (rulesSaveGeneration.current !== scheduledGen) return;
      const token = ++rulesAutosaveToken.current;
      void (async () => {
        setRulesAutosaveState("saving");
        try {
          if (rulesSaveGeneration.current !== scheduledGen) {
            setRulesAutosaveState("idle");
            return;
          }
          const u = callable<
            { id: string; rules: PlaylistRules; enrichEnabled: boolean; duplicateNewIntoLatest: boolean },
            { ok: boolean }
          >("updatePlaylist");
          await u({ id: playlistId, rules, enrichEnabled, duplicateNewIntoLatest: dupLatest });
          if (token !== rulesAutosaveToken.current || rulesSaveGeneration.current !== scheduledGen) return;
          setRulesAutosaveState("saved");
          window.setTimeout(() => {
            setRulesAutosaveState((s) => (s === "saved" ? "idle" : s));
          }, 1800);
        } catch (e) {
          if (token === rulesAutosaveToken.current && rulesSaveGeneration.current === scheduledGen) {
            setRulesAutosaveState("idle");
            notify(errMsg(e));
          }
        }
      })();
    }, 400);
    return () => window.clearTimeout(t);
  }, [rules, enrichEnabled, dupLatest, playlistId, user, notify]);

  const openFilterLike = (row: EditorRow, field: "name" | "group" | "url") => {
    setMenu(null);
    const phrase = rawFieldValue(field, row).trim();
    setFilterModal({
      row,
      field,
      mode: "exclude",
      patternEditor: "simple",
      simpleHow: "exact",
      simplePhrase: phrase,
      pattern: patternFromSimplePhrase("exact", phrase),
      standalone: false,
    });
  };

  const openStandaloneFilterRule = () => {
    if (!rules) return;
    setMenu(null);
    setFilterModal({
      row: { ...STANDALONE_RULE_ANCHOR },
      field: "name",
      mode: "exclude",
      patternEditor: "simple",
      simpleHow: "exact",
      simplePhrase: "",
      pattern: patternFromSimplePhrase("exact", ""),
      standalone: true,
    });
  };

  const applyFilterModal = () => {
    if (!filterModal || !rules) return;
    if (filterPatternIssue) {
      notify(filterPatternIssue);
      return;
    }
    if (simplePhraseWarning) {
      notify(simplePhraseWarning);
      return;
    }
    const { pattern, mode, field } = filterModal;
    try {
      void new RegExp(pattern);
    } catch {
      notify("Invalid pattern");
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
    const SCOPE_FIELD = {
      includeGroupPatterns: "includeGroupPatternScopes",
      excludeGroupPatterns: "excludeGroupPatternScopes",
      includeNamePatterns: "includeNamePatternScopes",
      excludeNamePatterns: "excludeNamePatternScopes",
      includeUrlPatterns: "includeUrlPatternScopes",
      excludeUrlPatterns: "excludeUrlPatternScopes",
    } as const satisfies Record<
      | "includeGroupPatterns"
      | "excludeGroupPatterns"
      | "includeNamePatterns"
      | "excludeNamePatterns"
      | "includeUrlPatterns"
      | "excludeUrlPatterns",
      keyof PlaylistRules
    >;
    const patternsKey = key as keyof typeof SCOPE_FIELD;
    const scopesKey = SCOPE_FIELD[patternsKey];
    const arr = [...rules[patternsKey]];
    const scopeArr: RulePatternTabScope[] = [...rules[scopesKey]];
    while (scopeArr.length < arr.length) scopeArr.push("all");
    scopeArr.length = arr.length;
    /** Include filters honor the category tab; excludes stay global so they match every channel on refresh. */
    const scope: RulePatternTabScope = mode === "exclude" ? "all" : tab === "all" ? "all" : tab;
    if (!arr.includes(pattern)) {
      arr.push(pattern);
      scopeArr.push(scope);
    }
    setRules({ ...rules, [patternsKey]: arr, [scopesKey]: scopeArr });
    setFilterModal(null);
    notify(
      mode === "exclude"
        ? `Added ${mode} pattern on ${field}.`
        : tab === "all"
          ? `Added ${mode} pattern on ${field}.`
          : `Added ${mode} pattern on ${field} (applies only to ${tab === "tv" ? "TV" : tab === "movie" ? "Movies" : "Series"}).`,
    );
  };

  const excludeSelectedByName = async () => {
    if (!rules || !playlistId) return;
    if (selected.size === 0) {
      notify("Select at least one row.");
      return;
    }

    rulesSaveGeneration.current += 1;
    setBusy(true);
    try {
      const fn = callable<
        { playlistId: string; channelIds: string[] },
        {
          ok: boolean;
          rules: PlaylistRules;
          addedChunks: number;
          totalChunks: number;
          channelRowsMatched: number;
          uniqueTitles: number;
          idsRequested: number;
          idsFoundInFile: number;
          idsMissingFromFile: number;
        }
      >("bulkExcludeByNamesForChannelIds", { timeout: 120_000 });
      const r = await fn({ playlistId, channelIds: [...selected] });
      const d = r.data;
      if (!d?.rules) {
        notify(
          "Exclude failed — empty response from the server. Deploy the latest Cloud Functions (including bulkExcludeByNamesForChannelIds).",
        );
        return;
      }
      skipNextRulesAutosave.current = true;
      setRules(d.rules);
      const parts: string[] = [];
      if (d.addedChunks > 0) {
        parts.push(
          `Added ${d.addedChunks.toLocaleString()} new name-exclude chunk(s) for ${d.channelRowsMatched.toLocaleString()} channel title row(s) (${d.uniqueTitles.toLocaleString()} unique titles) from ${d.idsFoundInFile.toLocaleString()} of ${d.idsRequested.toLocaleString()} selected id(s) in the playlist file.`,
        );
      } else {
        parts.push(
          `No new exclude chunks added — patterns for those ${d.channelRowsMatched.toLocaleString()} title row(s) (${d.uniqueTitles.toLocaleString()} unique) were already saved.`,
        );
      }
      if (d.idsMissingFromFile > 0) {
        parts.push(
          `${d.idsMissingFromFile.toLocaleString()} selected id(s) were not in the file (stale selection or rebuild changed ids).`,
        );
      }
      notify(parts.join(" "));
      clearSel();
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  /** Add allow-* regex chunks so selected rows pass the rules again after save + rebuild. */
  const includeSelectedAgain = () => {
    if (!rules) return;
    const inRulesDroppedView = editorDataSet === "rulesDropped";
    if (!inRulesDroppedView && !showExcluded) return;
    const keptRows = applyRulesPreview(rows.map(rowToPreviewEntry), rules);
    const keptIds = new Set(keptRows.map((e) => (e as RowEntry).__rowId));
    const pick = rows.filter((r) => selected.has(r.id) && !keptIds.has(r.id));
    if (pick.length === 0) {
      notify(
        selected.size > 0
          ? inRulesDroppedView
            ? "Nothing to add for the current selection — those rows already pass your saved rules in preview (try editing rules or pick other rows)."
            : "No selected rows are currently excluded — pick hidden channels or load more."
          : inRulesDroppedView
            ? "Select one or more hidden channels, then Include again to add allow rules for them."
            : "Select excluded channels to include again.",
      );
      return;
    }
    const chunkSize = 80;
    const addChunked = (
      rawValues: string[],
      into: string[],
      intoScopes: RulePatternTabScope[],
      field: "name" | "url" | "group",
    ): boolean => {
      while (intoScopes.length < into.length) intoScopes.push("all");
      intoScopes.length = into.length;
      const unique = [...new Set(rawValues.map((s) => s.trim()).filter(Boolean))];
      for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const inner = chunk.map((t) => escapeRegExp(t)).join("|");
        const pattern = `^(?:${inner})$`;
        try {
          void new RegExp(pattern);
        } catch {
          notify(`Could not build allow-by-${field} pattern(s) — try a smaller selection or shorter values.`);
          return false;
        }
        if (!into.includes(pattern)) {
          into.push(pattern);
          intoScopes.push("all");
        }
      }
      return true;
    };
    const allowNamePatterns = [...rules.allowNamePatterns];
    const allowNamePatternScopes = [...rules.allowNamePatternScopes];
    const allowUrlPatterns = [...rules.allowUrlPatterns];
    const allowUrlPatternScopes = [...rules.allowUrlPatternScopes];
    if (!addChunked(
      pick.map((r) => r.title),
      allowNamePatterns,
      allowNamePatternScopes,
      "name",
    ))
      return;
    if (!addChunked(
      pick.map((r) => r.url),
      allowUrlPatterns,
      allowUrlPatternScopes,
      "url",
    ))
      return;
    setRules({ ...rules, allowNamePatterns, allowNamePatternScopes, allowUrlPatterns, allowUrlPatternScopes });
    clearSel();
    notify(
      `Added allow patterns for ${pick.length.toLocaleString()} excluded channel(s). Refresh the player file when you want the hosted M3U to match.`,
    );
  };

  const filterPatternIssue = useMemo(() => {
    if (!filterModal) return null as string | null;
    try {
      void new RegExp(filterModal.pattern, "i");
      return null;
    } catch {
      return "This pattern is not valid. Fix it in the advanced editor, or switch back to Simple and pick again.";
    }
  }, [filterModal]);

  const previewMatches = useMemo(() => {
    if (!filterModal || filterPatternIssue) return [];
    const re = new RegExp(filterModal.pattern, "i");
    const field = filterModal.field;
    return visible.filter((r) => {
      const v = field === "name" ? r.title : field === "group" ? r.groupTitle : r.url;
      return re.test(v);
    });
  }, [filterModal, filterPatternIssue, visible]);

  const simplePhraseWarning = useMemo(() => {
    if (!filterModal || filterModal.patternEditor !== "simple") return null;
    const t = filterModal.simplePhrase.trim();
    if (t) return null;
    if (filterModal.simpleHow === "exact") return null;
    return "Type the text you want to match (or choose “Exactly this text” for empty lines).";
  }, [filterModal]);

  if (!playlistId) {
    return <p className="p-8 text-zinc-400">Missing playlist id.</p>;
  }

  const menuIsMultiChannel = Boolean(
    menu && menu.scope === "channel" && selected.size > 1 && selected.has(menu.row.id),
  );

  if (!user) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-zinc-950 px-4 py-8">
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
    <div className="flex min-h-[100dvh] flex-col bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 text-zinc-100 md:flex-row">
      <aside
        className={`z-20 flex shrink-0 flex-col border-zinc-800 bg-zinc-950/95 backdrop-blur md:sticky md:top-0 md:h-screen md:max-h-screen md:border-r md:shadow-xl md:shadow-black/30 md:transition-[width] md:duration-200 md:ease-out ${
          playlistSidebarOpen
            ? "max-h-[min(52vh,24rem)] w-full overflow-y-auto border-b md:max-h-none md:w-[min(22rem,calc(100vw-0.5rem))] sm:md:w-80"
            : "w-full border-b md:h-screen md:w-14 md:border-b-0"
        }`}
      >
        <div
          className={`flex shrink-0 items-center gap-2 border-b border-zinc-800 px-2 py-2.5 md:border-b-0 ${playlistSidebarOpen ? "" : "justify-center md:justify-start"}`}
        >
          {playlistSidebarOpen ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/90">Playlist info</p>
                <p className="truncate font-display text-base font-semibold text-white">{name || "Playlist"}</p>
              </div>
              <button
                type="button"
                title="Collapse sidebar"
                aria-expanded={playlistSidebarOpen}
                aria-controls="playlist-organizer-sidebar"
                aria-label="Collapse playlist sidebar"
                onClick={togglePlaylistSidebar}
                className="shrink-0 rounded-lg border border-zinc-700/80 p-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white"
              >
                ‹
              </button>
            </>
          ) : (
            <button
              type="button"
              title="Show playlist info"
              aria-expanded={false}
              aria-controls="playlist-organizer-sidebar"
              aria-label="Expand playlist sidebar"
              onClick={togglePlaylistSidebar}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-700/60 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white md:mx-auto md:h-10 md:w-10 md:gap-0 md:border-zinc-700/80 md:px-0 md:text-lg"
            >
              <span className="font-medium md:sr-only">Playlist menu</span>
              <span aria-hidden>›</span>
            </button>
          )}
        </div>
        {playlistSidebarOpen ? (
          <div
            id="playlist-organizer-sidebar"
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-4"
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500">Visual playlist editor</p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                Use <strong className="font-normal text-zinc-400">In player file</strong> to match what your IPTV app loads today, or{" "}
                <strong className="font-normal text-zinc-400">Hidden by rules</strong> to see channels the server stripped on the last
                refresh. Filters, order, and checkboxes <strong className="font-normal text-zinc-400">save automatically</strong>.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800" to="/">
                Main app
              </Link>
              <button type="button" onClick={() => void signOut(auth)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
                Sign out
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex w-full items-center gap-0.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void rebuildM3u()}
                  className="min-w-0 flex-1 rounded-lg bg-emerald-500 px-2 py-2.5 text-sm font-semibold leading-snug text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                >
                  Refresh player file from sources
                </button>
                <InlineHelp text="Downloads fresh M3U from each saved source, merges them, applies your rules and order, then overwrites the hosted file behind your player URL. Your app keeps the same URL; large lists can take several minutes." />
              </div>
              {busy && refreshProgress ? (
                <p className="text-center text-xs leading-snug text-amber-200/90" aria-live="polite">
                  {formatRefreshProgressLine(refreshProgress)}
                </p>
              ) : null}
              <p className="text-center text-[11px] text-zinc-500" aria-live="polite">
                {rulesAutosaveState === "saving" ? (
                  <span className="text-sky-300/90">Saving…</span>
                ) : rulesAutosaveState === "saved" ? (
                  <span className="text-emerald-300/90">Saved</span>
                ) : (
                  <span>Rules save automatically</span>
                )}
              </p>
              <div className="flex w-full items-center gap-0.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load()}
                  title="Discards unsaved-in-memory table state: re-downloads the current list from Firebase for this data source (player file or hidden-by-rules), reapplies your saved rules metadata, and resets pagination to the first page."
                  className="min-w-0 flex-1 rounded-lg border border-zinc-600 px-2 py-2.5 text-sm leading-snug hover:bg-zinc-800 disabled:opacity-40"
                >
                  Reload table from server
                </button>
                <InlineHelp text="Fetches the latest channel list from the server for whichever data source is selected next to the category tabs (player file vs hidden by rules). Use this if the table looks stale after a refresh elsewhere, without running a full source pull again." />
              </div>
            </div>
            {publicToken ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Player URL</p>
                <code className="mt-1 block break-all text-[11px] leading-snug text-emerald-200/90">{publicPlaylistUrl(publicToken)}</code>
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden pb-[env(safe-area-inset-bottom,0px)]">
        <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
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
              {t === "all"
                ? `All (${(totalsByTab?.all ?? visible.length).toLocaleString()})`
                : t === "tv"
                  ? `TV (${(totalsByTab?.tv ?? visible.filter((r) => r.tab === "tv").length).toLocaleString()})`
                  : t === "movie"
                    ? `Movies (${(totalsByTab?.movie ?? visible.filter((r) => r.tab === "movie").length).toLocaleString()})`
                    : `Series (${(totalsByTab?.series ?? visible.filter((r) => r.tab === "series").length).toLocaleString()})`}
            </button>
          ))}
          <span className="ml-auto text-xs text-zinc-500">
            Loaded {rows.length.toLocaleString()} / {total.toLocaleString()}{" "}
            {editorDataSet === "rulesDropped" ? "hidden rows" : "rows"}
            {editorDataSet === "player" && excludedCount > 0 && !showExcluded ? ` · ${excludedCount} hidden by rules (preview)` : ""}
            {editorDataSet === "player" && showExcluded ? " · showing rules preview (excluded only)" : ""}
            {editorDataSet === "rulesDropped" ? " · last refresh snapshot" : ""}
            {enrichEnabled ? " · enrichment on" : ""}
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 sm:flex-row sm:flex-wrap sm:items-center">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Data source</span>
          <div className="flex flex-wrap gap-1 rounded-lg bg-zinc-900/90 p-0.5">
            <button
              type="button"
              onClick={() => setEditorDataSet("player")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                editorDataSet === "player" ? "bg-emerald-500 text-emerald-950" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              In player file
            </button>
            <button
              type="button"
              onClick={() => setEditorDataSet("rulesDropped")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                editorDataSet === "rulesDropped"
                  ? "bg-violet-500 text-violet-950"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              Hidden by rules (last rebuild)
            </button>
          </div>
          <p className="text-xs leading-snug text-zinc-500 sm:ml-auto sm:max-w-xl">
            {editorDataSet === "player"
              ? "Table rows match the hosted M3U your IPTV app uses. The “hidden by rules” count is a live preview: rows still in the file that your saved rules would remove before the next refresh."
              : "Rows the server removed when it last built the player file. Select any you want back and tap Include again to add allow patterns, then refresh the player file."}
          </p>
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

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 shadow-sm">
          <div className="flex flex-col gap-1.5 border-b border-zinc-800/80 pb-4">
            <label className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-4">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Search playlist
                {q.trim() !== serverQuery ? (
                  <span className="mt-0.5 block font-normal normal-case text-zinc-600">Typing…</span>
                ) : null}
              </span>
              <input
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 shadow-inner outline-none transition focus:border-zinc-600 focus:ring-2 focus:ring-zinc-500/25"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, group, or URL (server filter, debounced)…"
                type="search"
                autoComplete="off"
                maxLength={LIMITS.MAX_EDITOR_SEARCH_CHARS}
              />
            </label>
          </div>

          <div className="pt-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Playlist tools</p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="hidden w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 sm:block">
                  Select
                </span>
                <div className={orgCluster}>
                  <button type="button" onClick={selectAllVisible} className={orgBtnOutline}>
                    Visible rows
                  </button>
                  <button type="button" onClick={clearSel} className={orgBtnOutline}>
                    Clear
                  </button>
                  <button
                    type="button"
                    disabled={busy || total === 0 || editorDataSet === "rulesDropped"}
                    onClick={() => void selectEntirePlaylist()}
                    title={
                      editorDataSet === "rulesDropped"
                        ? "Switch to “In player file” to select every id in the hosted M3U (this list is only channels removed by rules)."
                        : "Select every channel id on the server (may be more than loaded in the table)"
                    }
                    className={orgBtnEmerald}
                  >
                    Entire playlist
                  </button>
                  {selected.size > 0 ? (
                    <span className="flex items-center rounded-lg bg-zinc-800/80 px-2.5 py-1.5 text-xs font-medium tabular-nums text-zinc-300">
                      {selected.size.toLocaleString()} selected
                    </span>
                  ) : null}
                </div>

                {groupedVisible.length > 0 ? (
                  <>
                    <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 sm:block">
                      Groups
                    </span>
                    <div className={orgCluster}>
                      <button type="button" onClick={collapseAllGroups} className={orgBtnOutline}>
                        Collapse all
                      </button>
                      <button type="button" onClick={expandAllGroups} className={orgBtnOutline}>
                        Expand all
                      </button>
                    </div>
                  </>
                ) : null}

                {editorDataSet === "player" && rules && excludedCount > 0 ? (
                  <>
                    <span className="hidden w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 sm:block">
                      View
                    </span>
                    <div className={orgCluster}>
                      <button
                        type="button"
                        onClick={() => setShowExcluded((v) => !v)}
                        className={
                          showExcluded
                            ? `${orgBtn} border border-violet-500/50 bg-violet-500/15 font-medium text-violet-100`
                            : orgBtnOutline
                        }
                      >
                        {showExcluded ? "Included only" : `Excluded (${excludedCount})`}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="hidden w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 sm:block">
                  Rules
                </span>
                <div className={`${orgCluster} flex-1 sm:flex-initial`}>
                  <button
                    type="button"
                    disabled={busy || !rules || selected.size === 0 || editorDataSet === "rulesDropped"}
                    onClick={() => void excludeSelectedByName()}
                    title={
                      editorDataSet === "rulesDropped"
                        ? "Switch to “In player file” to run bulk exclude against the hosted M3U on the server."
                        : excludeSelectedButtonTitle
                    }
                    className={orgBtnAmber}
                  >
                    {excludeSelectedStats.selectedTotal === 0 ? (
                      "Exclude selected"
                    ) : excludeSelectedStats.selectedTotal === excludeSelectedStats.serverTotalChannels ? (
                      <>Exclude selected ({excludeSelectedStats.selectedTotal.toLocaleString()}) — full playlist</>
                    ) : (
                      <>
                        Exclude selected ({excludeSelectedStats.selectedTotal.toLocaleString()} of{" "}
                        {excludeSelectedStats.serverTotalChannels.toLocaleString()})
                      </>
                    )}
                  </button>
                  {rules &&
                  ((editorDataSet === "player" && showExcluded) || editorDataSet === "rulesDropped") ? (
                    <button
                      type="button"
                      disabled={busy || selected.size === 0}
                      onClick={includeSelectedAgain}
                      title={
                        editorDataSet === "rulesDropped"
                          ? "Adds name + URL allow patterns for the selection so these streams can pass your filters on the next refresh (same as Include again in the player list’s excluded preview)."
                          : undefined
                      }
                      className={orgBtnSkyLine}
                    >
                      Include again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy || !rules}
                    onClick={openStandaloneFilterRule}
                    className={orgBtnSkyLine}
                  >
                    Add a rule
                  </button>
                </div>

                {hasMore ? (
                  <div className="flex w-full flex-col items-end gap-1 sm:ml-auto sm:w-auto">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void loadAllRemaining()}
                      title={`Fetches all remaining pages for the current category tab and search (up to ${LIMITS.MAX_CHANNELS_PER_PLAYLIST.toLocaleString()} channels in chunks of ${LIMITS.MAX_EDITOR_PAGE_SIZE.toLocaleString()}).`}
                      className={orgBtnSkySolid}
                    >
                      Load all channels
                    </button>
                    <span className="max-w-xs text-right text-[10px] text-zinc-500">
                      Fetches each page from the server and appends rows until everything for this search and tab is shown.
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <p className="mt-3 border-t border-zinc-800/80 pt-3 text-[11px] leading-relaxed text-zinc-600">
              <span className="font-medium text-zinc-500">Reorder:</span> drag the six-dot handle on a group bar or on a channel row.
              Group order and channel order live in your rules (auto-saved) — refresh the player file when you want the hosted M3U to match.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {groupedVisible.map(({ group, rows: gRows }) => {
            const allOn = gRows.length > 0 && gRows.every((r) => selected.has(r.id));
            const someOn = gRows.some((r) => selected.has(r.id)) && !allOn;
            const expanded = expandedGroups.has(group);
            return (
              <article
                key={group}
                className="overflow-hidden rounded-2xl border border-zinc-800/90 bg-zinc-900/35 shadow-md shadow-black/20"
              >
                <div
                  className="flex flex-wrap items-center gap-3 border-b border-zinc-800/80 bg-gradient-to-r from-zinc-800/90 via-zinc-900/70 to-zinc-950/40 px-4 py-3"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const anchor = anchorRowForGroupContextMenu(gRows, group);
                    if (!anchor) return;
                    setMenu({ x: e.clientX, y: e.clientY, row: anchor, scope: "group", groupKey: group });
                  }}
                  onDragOver={(e) => {
                    if (dragGroupRef.current) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragGroupRef.current;
                    dragGroupRef.current = null;
                    if (!from || !rules || from === group) return;
                    reorderGroupsAfterDrag(from, group);
                  }}
                  onDragEnd={() => {
                    dragGroupRef.current = null;
                    dragChannelRef.current = null;
                  }}
                >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          title={expanded ? "Hide channels in this group" : "Show channels in this group"}
                          aria-expanded={expanded}
                          onClick={() => toggleGroupCollapsed(group)}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-950/50 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
                        >
                          <svg
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className={`h-4 w-4 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
                            aria-hidden
                          >
                            <path
                              fillRule="evenodd"
                              d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </button>
                        <GroupHeaderCheckbox allSelected={allOn} someSelected={someOn} onChange={() => toggleGroupRows(gRows)} />
                        <span
                          draggable
                          title="Drag to reorder groups"
                          onDragStart={(e) => {
                            e.stopPropagation();
                            dragGroupRef.current = group;
                            dragChannelRef.current = null;
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", `group:${group}`);
                          }}
                          onDragEnd={() => {
                            dragGroupRef.current = null;
                          }}
                          className="inline-flex cursor-grab select-none items-center rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-1.5 py-1.5 text-zinc-500 hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-zinc-300 active:cursor-grabbing"
                        >
                          <DragGripIcon />
                        </span>
                      </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapsed(group)}
                      className="text-left text-base font-semibold tracking-tight text-white hover:text-emerald-200"
                    >
                      {group}
                    </button>
                    <span className="text-xs font-medium text-zinc-500">
                      {gRows.length.toLocaleString()} channel{gRows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                {expanded ? (
                  <VirtualGroupChannelList
                    group={group}
                    gRows={gRows}
                    selected={selected}
                    toggleSel={toggleSel}
                    setMenu={setMenu}
                    reorderChannelInGroup={reorderChannelInGroup}
                    dragChannelRef={dragChannelRef}
                    dragGroupRef={dragGroupRef}
                  />
                ) : (
                  <p className="px-4 py-3 text-center text-xs text-zinc-600">Collapsed — use the arrow to show channels.</p>
                )}
              </article>
            );
          })}
          {visible.length === 0 && !busy && (
            <p className="rounded-2xl border border-zinc-800 bg-zinc-900/40 py-12 text-center text-sm text-zinc-500">
              {editorDataSet === "rulesDropped" && total === 0
                ? "No “hidden by rules” snapshot for this playlist yet. Run “Refresh player file from sources” once so the server can write it, or your rules may not have removed any channels on the last run."
                : "No channels match this tab or search."}
            </p>
          )}
        </div>

        <p className="text-xs text-zinc-600">
          Use the group bar checkbox to select every channel in that group, or pick channels in the list. Right-click a
          channel row or <strong className="font-normal text-zinc-500">group bar</strong> for filters, order (move to top), or use{" "}
          <strong className="font-normal text-zinc-500">Add a rule</strong> under Playlist tools. Drag the grip handle on a group or
          channel to reorder; rules save automatically, then <strong className="font-normal text-zinc-500">refresh the player file</strong>{" "}
          so the hosted M3U matches.
          {editorDataSet === "player" && showExcluded
            ? " With excluded rows visible, “Include selected again” adds name/URL allow patterns for the selection — refresh the player file when ready."
            : editorDataSet === "rulesDropped"
              ? " On “Hidden by rules”, select rows and use Include again to add allow patterns, or edit excludes under Add a rule — then refresh the player file so apps pick up changes."
              : ""}
        </p>
        </div>
      </div>

      {menu && (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default bg-black/40" aria-label="Close menu" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 min-w-[200px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {!menuIsMultiChannel ? (
              <>
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
                <div className="my-1 border-t border-zinc-800" />
              </>
            ) : null}
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Order</p>
            {menu.scope === "group" ? (
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                disabled={!rules}
                onClick={() => moveGroupToTopFromMenu()}
              >
                Move group to top of list
              </button>
            ) : (
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                disabled={!rules}
                onClick={() => moveChannelToTopFromMenu()}
              >
                {menuIsMultiChannel
                  ? `Move ${selected.size.toLocaleString()} channels to top of each group`
                  : "Move channel to top of group"}
              </button>
            )}
          </div>
        </>
      )}

      {filterModal && rules && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4">
          <div className="max-h-[min(90dvh,calc(100svh-2rem))] w-full max-w-2xl overflow-y-auto overscroll-y-contain rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            <div className="border-b border-zinc-800 px-4 py-4 sm:px-5">
              <h2 className="text-lg font-semibold text-white">
                {filterModal.standalone ? "Add a playlist rule" : "Filter like this channel"}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Choose whether matching channels should be <strong className="font-medium text-zinc-300">hidden</strong> or{" "}
                <strong className="font-medium text-zinc-300">kept</strong>. The preview only looks at rows{" "}
                <strong className="font-normal text-zinc-300">already loaded in this table</strong>; after rules sync to the server,
                the same rule runs on the full list when you rebuild.
              </p>
            </div>
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {filterModal.standalone ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Match on</p>
                  <p className="mt-1 text-xs text-zinc-500">Which part of each channel should this rule look at?</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["name", "group", "url"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFilterModal({ ...filterModal, field: f })}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                          filterModal.field === f
                            ? "border-sky-500/70 bg-sky-500/15 text-sky-100"
                            : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                        }`}
                      >
                        {fieldLabel(f)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">From this row</p>
                  <p className="mt-1 text-sm text-zinc-300">
                    <span className="text-zinc-500">{fieldLabel(filterModal.field)}:</span>{" "}
                    <span className="break-words text-white">
                      {rawFieldValue(filterModal.field, filterModal.row).trim() || "—"}
                    </span>
                  </p>
                </div>
              )}

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">What should happen?</p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setFilterModal({ ...filterModal, mode: "exclude" })}
                    className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                      filterModal.mode === "exclude"
                        ? "border-rose-500/70 bg-rose-500/15 text-rose-100 ring-1 ring-rose-500/40"
                        : "border-zinc-700 bg-zinc-950/50 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-semibold text-white">Hide matching channels</span>
                    <span className="mt-1 block text-xs text-zinc-500">They disappear from the playlist (exclude).</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterModal({ ...filterModal, mode: "include" })}
                    className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                      filterModal.mode === "include"
                        ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-100 ring-1 ring-emerald-500/40"
                        : "border-zinc-700 bg-zinc-950/50 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-semibold text-white">Keep only matching channels</span>
                    <span className="mt-1 block text-xs text-zinc-500">Everything else is hidden (include / whitelist).</span>
                  </button>
                </div>
              </div>

              <div className="flex rounded-lg border border-zinc-700 bg-zinc-950 p-1">
                <button
                  type="button"
                  onClick={() =>
                    setFilterModal({
                      ...filterModal,
                      patternEditor: "simple",
                      pattern: patternFromSimplePhrase(filterModal.simpleHow, filterModal.simplePhrase),
                    })
                  }
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                    filterModal.patternEditor === "simple" ? "bg-zinc-700 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Simple
                </button>
                <button
                  type="button"
                  onClick={() => setFilterModal({ ...filterModal, patternEditor: "advanced" })}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                    filterModal.patternEditor === "advanced" ? "bg-zinc-700 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Advanced pattern
                </button>
              </div>

              {filterModal.patternEditor === "simple" ? (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Text to match on</span>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600"
                      value={filterModal.simplePhrase}
                      placeholder="e.g. channel name, part of a URL, or one word"
                      onChange={(e) =>
                        setFilterModal({
                          ...filterModal,
                          simplePhrase: e.target.value,
                          pattern: patternFromSimplePhrase(filterModal.simpleHow, e.target.value),
                        })
                      }
                    />
                    <span className="mt-1 block text-xs text-zinc-500">
                      You can shorten or change it — special characters are treated as plain text, not code.
                    </span>
                  </label>
                  {simplePhraseWarning ? (
                    <p className="rounded-lg border border-amber-800/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{simplePhraseWarning}</p>
                  ) : null}
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Match style</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SIMPLE_MATCH_OPTIONS.map((opt) => {
                      const on = filterModal.simpleHow === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() =>
                            setFilterModal({
                              ...filterModal,
                              simpleHow: opt.id,
                              pattern: patternFromSimplePhrase(opt.id, filterModal.simplePhrase),
                            })
                          }
                          className={`rounded-xl border px-3 py-3 text-left transition ${
                            on
                              ? "border-sky-500/70 bg-sky-500/10 text-sky-100 ring-1 ring-sky-500/35"
                              : "border-zinc-700 bg-zinc-950/60 hover:border-zinc-600"
                          }`}
                        >
                          <span className="text-sm font-semibold text-white">{opt.title}</span>
                          <span className="mt-1 block text-xs leading-snug text-zinc-500">{opt.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">Pattern (technical)</label>
                  <textarea
                    className="h-24 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
                    value={filterModal.pattern}
                    spellCheck={false}
                    onChange={(e) => setFilterModal({ ...filterModal, pattern: e.target.value })}
                  />
                  <p className="text-xs text-zinc-500">
                    This is a regular expression (case-insensitive). Switch to <strong className="font-normal text-zinc-400">Simple</strong>{" "}
                    if you do not need custom syntax.
                  </p>
                </div>
              )}

              {filterPatternIssue ? (
                <p className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{filterPatternIssue}</p>
              ) : null}

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Preview in this table</p>
                  <p className="text-sm text-zinc-300">
                    <span className="text-emerald-400">{previewMatches.length}</span>{" "}
                    <span className="text-zinc-500">loaded row{previewMatches.length === 1 ? "" : "s"} match</span>
                  </p>
                </div>
                <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-zinc-800/80 bg-zinc-950 p-2 text-xs text-zinc-300">
                  {filterPatternIssue ? (
                    <p className="py-4 text-center text-zinc-500">Fix the pattern to see matching channels here.</p>
                  ) : previewMatches.length === 0 ? (
                    <p className="py-4 text-center text-zinc-500">No loaded rows match yet — try another style or edit the text.</p>
                  ) : (
                    previewMatches.slice(0, 80).map((r) => (
                      <div key={r.id} className="flex items-start gap-2 border-b border-zinc-800/60 py-2 last:border-0">
                        <span className="mt-0.5 text-emerald-500" aria-hidden>
                          ✓
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 break-words text-zinc-200">{r.title}</span>
                          {filterModal.field === "group" ? (
                            <span className="mt-0.5 block truncate text-zinc-500">{r.groupTitle}</span>
                          ) : null}
                          {filterModal.field === "url" ? (
                            <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-500">{r.url}</span>
                          ) : null}
                        </span>
                      </div>
                    ))
                  )}
                  {!filterPatternIssue && previewMatches.length > 80 ? (
                    <p className="py-2 text-center text-zinc-600">…and {previewMatches.length - 80} more in this view</p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 px-4 py-4 sm:px-5">
              <button type="button" className="rounded-lg border border-zinc-600 px-4 py-2 text-sm" onClick={() => setFilterModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(filterPatternIssue || simplePhraseWarning)}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={applyFilterModal}
              >
                Add to rules
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-[60] max-w-[min(calc(100vw-1.5rem),28rem)] -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-3 text-center text-sm leading-snug shadow-xl sm:py-2">
          {toast}
        </div>
      )}
    </div>
  );
}
