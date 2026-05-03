import { useVirtualizer } from "@tanstack/react-virtual";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, callable, db, publicPlaylistUrl } from "./firebase";
import { ExpandableHelp, InlineHelp } from "./uiHelp";
import { hashEditorFilterKey } from "./editorFilterKey";
import { formatRefreshProgressLine, type PlaylistRefreshProgress } from "./refreshProgressFormat";
import { LIMITS, type PlaylistRules, type RulePatternTabScope } from "../../functions/src/constants";
import { escapeRegExp } from "../../functions/src/excludeNamePatternChunks";
import { applyRulesPreview, type PreviewChannel } from "./playlistRulesPreview";

type EditorTab = "tv" | "movie" | "series";

type EditorHydrationDoc = {
  state: "idle" | "running" | "complete" | "failed";
  dataSet: "player" | "rulesDropped";
  filterKey: string;
  indexedThrough: number;
  chunkFilesWritten?: number;
  filteredTotal?: number;
  message?: string;
};

type EditorHydrationTickResult = {
  state: string;
  indexedThrough: number;
  chunkFilesWritten: number;
  filteredTotal?: number;
  message?: string;
};

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
      ? "border-emerald-600/45 bg-emerald-600/15 text-emerald-100"
      : tab === "movie"
        ? "border-amber-600/45 bg-amber-600/15 text-amber-100"
        : "border-sky-600/45 bg-sky-600/15 text-sky-100";
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
        className="h-11 w-11 shrink-0 rounded-lg border border-zinc-700/80 bg-zinc-900 object-cover"
        onContextMenu={(e) => e.preventDefault()}
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

/** Server search debounce — long enough to avoid a callable per keystroke. */
const EDITOR_SEARCH_DEBOUNCE_MS = 560;

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
    overscan: 5,
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
              className={`absolute left-0 top-0 box-border flex w-full max-w-full gap-3 border-b border-zinc-600/35 px-4 py-3 transition-colors hover:bg-zinc-700/20 ${
                selected.has(r.id) ? "bg-emerald-500/5 ring-1 ring-inset ring-emerald-500/25" : ""
              }`}
              style={{ transform: `translateY(${vi.start}px)` }}
              onContextMenuCapture={(e) => {
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
                {r.tvgName ? <div className="mt-0.5 line-clamp-1 text-xs text-zinc-400">{r.tvgName}</div> : null}
                <div className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-zinc-400 lg:text-xs">{r.url}</div>
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
const orgCluster =
  "inline-flex flex-wrap items-center gap-1 rounded-xl border-2 border-zinc-300/40 bg-zinc-800 p-1 shadow-md shadow-black/25 ring-1 ring-zinc-950/30";
const orgBtn =
  "min-h-10 rounded-lg px-3 py-2 text-sm text-zinc-100 transition hover:bg-zinc-700/95 disabled:pointer-events-none disabled:opacity-40 sm:min-h-0";
const orgBtnOutline = `${orgBtn} border border-zinc-600/60 hover:border-zinc-500`;
const orgBtnEmerald = `${orgBtn} border border-emerald-600/35 bg-emerald-500/12 font-medium text-emerald-100 hover:bg-emerald-500/22`;
const orgBtnAmber = `${orgBtn} border border-amber-600/40 bg-amber-600/15 text-amber-100 hover:bg-amber-600/25`;
const orgBtnSkyLine = `${orgBtn} border border-sky-600/40 bg-sky-600/12 text-sky-100 hover:bg-sky-600/22`;
const orgBtnSkySolid =
  "min-h-11 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500 disabled:pointer-events-none disabled:opacity-40 sm:min-h-0 sm:py-2";

const PLAYLIST_ORG_SIDEBAR_KEY = "playlistOrganizer.playlistSidebarOpen";

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
  /** Mutations / long user actions (rebuild, bulk exclude, select-all ids, load-all). */
  const [busy, setBusy] = useState(false);
  /** Editor list fetch only — does not lock the rest of the UI so search/tab changes stay usable. */
  const [listLoading, setListLoading] = useState(false);

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
  const [editorHydrationDoc, setEditorHydrationDoc] = useState<EditorHydrationDoc | null>(null);
  const [editorFilterKey, setEditorFilterKey] = useState("");
  const editorHydrationPrevSigRef = useRef("");
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
  const [refreshResume, setRefreshResume] = useState<{
    sourceIndex: number;
    sourceId: string;
    skipEmitFirst: number;
  } | null>(null);

  useEffect(() => {
    if (!playlistId || !user) {
      setRefreshProgress(null);
      setRefreshResume(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "playlists", playlistId),
      (snap) => {
        if (!snap.exists()) {
          setRefreshProgress(null);
          setRefreshResume(null);
          setEditorHydrationDoc(null);
          return;
        }
        const row = snap.data();
        const rp = row?.refreshProgress as unknown;
        if (rp && typeof rp === "object" && rp !== null && "channelsSoFar" in rp) {
          setRefreshProgress(rp as PlaylistRefreshProgress);
        } else {
          setRefreshProgress(null);
        }
        const rr = row?.refreshResume as unknown;
        setRefreshResume(
          rr &&
            typeof rr === "object" &&
            rr !== null &&
            typeof (rr as { sourceIndex?: unknown }).sourceIndex === "number" &&
            typeof (rr as { sourceId?: unknown }).sourceId === "string" &&
            typeof (rr as { skipEmitFirst?: unknown }).skipEmitFirst === "number"
            ? (rr as { sourceIndex: number; sourceId: string; skipEmitFirst: number })
            : null,
        );
        const eh = row?.editorHydration as unknown;
        if (
          eh &&
          typeof eh === "object" &&
          eh !== null &&
          typeof (eh as { state?: unknown }).state === "string" &&
          typeof (eh as { filterKey?: unknown }).filterKey === "string" &&
          typeof (eh as { dataSet?: unknown }).dataSet === "string" &&
          typeof (eh as { indexedThrough?: unknown }).indexedThrough === "number"
        ) {
          setEditorHydrationDoc(eh as EditorHydrationDoc);
        } else {
          setEditorHydrationDoc(null);
        }
      },
      () => {
        setRefreshProgress(null);
        setRefreshResume(null);
        setEditorHydrationDoc(null);
      },
    );
    return () => unsub();
  }, [playlistId, user]);

  useEffect(() => {
    const next = q.trim().slice(0, LIMITS.MAX_EDITOR_SEARCH_CHARS);
    if (next === serverQuery) return;
    const delay = next.length === 0 ? 0 : EDITOR_SEARCH_DEBOUNCE_MS;
    const t = window.setTimeout(() => {
      startTransition(() => setServerQuery(next));
    }, delay);
    return () => window.clearTimeout(t);
  }, [q, serverQuery]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tabFilter = tab === "tv" || tab === "movie" || tab === "series" ? tab : "all";
      const dataSet = editorDataSet === "rulesDropped" ? "rulesDropped" : "player";
      const needle = serverQuery.trim().slice(0, LIMITS.MAX_EDITOR_SEARCH_CHARS).toLowerCase();
      const k = await hashEditorFilterKey(dataSet, tabFilter, needle);
      if (!cancelled) setEditorFilterKey(k);
    })();
    return () => {
      cancelled = true;
    };
  }, [editorDataSet, tab, serverQuery]);

  const editorHydrationRunningMatch = useMemo(() => {
    const hyd = editorHydrationDoc;
    const ds = editorDataSet === "rulesDropped" ? "rulesDropped" : "player";
    return Boolean(
      editorFilterKey &&
        hyd &&
        hyd.state === "running" &&
        hyd.filterKey === editorFilterKey &&
        hyd.dataSet === ds,
    );
  }, [editorHydrationDoc, editorFilterKey, editorDataSet]);

  useEffect(() => {
    if (!playlistId || !user || !editorFilterKey || !editorHydrationRunningMatch) return;
    const ds = editorDataSet === "rulesDropped" ? "rulesDropped" : "player";
    const tickPayload = {
      playlistId,
      dataSet: ds,
      ...(serverQuery ? { search: serverQuery } : {}),
      ...(tab !== "all" ? { tab } : {}),
    };
    const fn = callable<typeof tickPayload, EditorHydrationTickResult>("editorHydrationTick", { timeout: 120_000 });
    void fn(tickPayload).catch(() => undefined);
    const id = window.setInterval(() => {
      void fn(tickPayload).catch(() => undefined);
    }, 2800);
    return () => window.clearInterval(id);
  }, [playlistId, user, editorFilterKey, editorHydrationRunningMatch, editorDataSet, tab, serverQuery]);

  /** Fetches one page from offset 0 for the current tab/search/source, then shows it (no silent background paging). */
  const load = useCallback(async () => {
    if (!playlistId || !user) return;
    loadedThroughRef.current = 0;
    editorFetchGen.current += 1;
    const session = editorFetchGen.current;
    setListLoading(true);
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
      const tickFn = callable<
        { playlistId: string; dataSet?: string; tab?: string; search?: string },
        EditorHydrationTickResult
      >("editorHydrationTick", { timeout: 120_000 });
      void tickFn({
        playlistId,
        dataSet: editorDataSet === "rulesDropped" ? "rulesDropped" : "player",
        ...(serverQuery ? { search: serverQuery } : {}),
        ...(tab !== "all" ? { tab } : {}),
      }).catch(() => undefined);
    } catch (e) {
      notify(errMsg(e));
    } finally {
      if (session === editorFetchGen.current) setListLoading(false);
    }
  }, [playlistId, user, notify, editorDataSet, serverQuery, tab]);

  useEffect(() => {
    const hyd = editorHydrationDoc;
    const ds = editorDataSet === "rulesDropped" ? "rulesDropped" : "player";
    if (!hyd || !editorFilterKey || hyd.filterKey !== editorFilterKey || hyd.dataSet !== ds) {
      editorHydrationPrevSigRef.current = "";
      return;
    }
    const sig = `${hyd.filterKey}|${hyd.state}`;
    const prev = editorHydrationPrevSigRef.current;
    if (hyd.state === "complete" && prev === `${hyd.filterKey}|running`) {
      void load();
    }
    editorHydrationPrevSigRef.current = sig;
  }, [editorHydrationDoc, editorFilterKey, editorDataSet, load]);

  /** Fetches every remaining page from the current offset until the server reports no more rows. */
  const loadAllRemaining = useCallback(async () => {
    if (!playlistId || !user) return;
    editorFetchGen.current += 1;
    const snapshotGen = editorFetchGen.current;
    setListLoading(true);
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
      if (editorFetchGen.current === snapshotGen) setListLoading(false);
    }
  }, [playlistId, user, notify, editorDataSet, serverQuery, tab]);

  useEffect(() => {
    if (user && playlistId) void load();
  }, [user, playlistId, load]);

  /** Defer rules preview + grouping so typing, tabs, and fetches stay responsive with huge lists. */
  const rowsForPreview = useDeferredValue(rows);

  const { tableSourceRows, excludedCount } = useMemo(() => {
    if (editorDataSet === "rulesDropped") {
      return { tableSourceRows: rowsForPreview, excludedCount: 0 };
    }
    if (!rules || rowsForPreview.length === 0) {
      return { tableSourceRows: rowsForPreview, excludedCount: 0 };
    }
    const keptRows = applyRulesPreview(rowsForPreview.map(rowToPreviewEntry), rules);
    const keptIds = new Set(keptRows.map((e) => (e as RowEntry).__rowId));
    const excluded = rowsForPreview.filter((r) => !keptIds.has(r.id));
    const excludedCount = excluded.length;
    const tableSourceRows = showExcluded ? excluded : rowsForPreview.filter((r) => keptIds.has(r.id));
    return { tableSourceRows, excludedCount };
  }, [rowsForPreview, rules, showExcluded, editorDataSet]);

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

  /** Reorder `channelOrder` so every selected id is moved to the front (visible-table order first, then remaining selected). */
  const moveSelectedChannelsToTop = useCallback(() => {
    if (!rules || selected.size === 0) return;
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
    const headSet = new Set(ordered);
    const rest = (rules.channelOrder ?? []).filter((x) => !headSet.has(x));
    const merged = capChannelOrderList([...ordered, ...rest]);
    setRules({ ...rules, channelOrder: merged });
    notify(
      ordered.length > 1
        ? `Moved ${ordered.length.toLocaleString()} channels to the top of each group — refresh the player file when you want the hosted M3U to match.`
        : "Channel moved to top of its group — refresh the player file when you want the hosted M3U to match.",
    );
  }, [rules, selected, groupedVisible, notify]);

  const moveChannelToTopFromMenu = useCallback(() => {
    if (!menu || !rules || menu.scope !== "channel") return;
    if (selected.size > 1) {
      moveSelectedChannelsToTop();
    } else {
      const headIds = [menu.row.id];
      const headSet = new Set(headIds);
      const rest = (rules.channelOrder ?? []).filter((x) => !headSet.has(x));
      const merged = capChannelOrderList([...headIds, ...rest]);
      setRules({ ...rules, channelOrder: merged });
      notify("Channel moved to top of its group — refresh the player file when you want the hosted M3U to match.");
    }
    setMenu(null);
  }, [menu, rules, moveSelectedChannelsToTop]);

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

  const rebuildM3u = async (opts?: { resume?: boolean }) => {
    if (!playlistId) return;
    setBusy(true);
    try {
      rulesSaveGeneration.current += 1;
      const fn = callable<
        { playlistId: string; resume?: boolean },
        { ok: boolean; channelCount: number }
      >("refreshPlaylist", {
        timeout: 600_000,
      });
      await fn({ playlistId, resume: Boolean(opts?.resume) });
      notify(
        opts?.resume
          ? "Resume finished — reloading this table from the server…"
          : "Player file updated — reloading this table from the server…",
      );
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

  const menuIsMultiChannel = Boolean(menu && menu.scope === "channel" && selected.size > 1);
  /** Firestore progress survives a browser reload — server refresh may still be running. */
  const serverReportsRefreshInFlight = Boolean(refreshProgress);

  if (!user) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-zinc-600 px-4 py-8">
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
    <div className="flex min-h-[100dvh] flex-col bg-gradient-to-b from-zinc-800 via-zinc-600 to-zinc-800 text-zinc-100 md:flex-row">
      <aside
        className={`z-20 flex shrink-0 flex-col border-zinc-300/45 bg-zinc-700/98 shadow-xl shadow-black/25 backdrop-blur md:sticky md:top-0 md:h-screen md:max-h-screen md:transition-[width] md:duration-200 md:ease-out border-b-2 md:border-b-0 md:border-r-2 ${
          playlistSidebarOpen
            ? "max-h-[min(52vh,24rem)] w-full overflow-y-auto border-b md:max-h-none md:w-[min(22rem,calc(100vw-0.5rem))] sm:md:w-80"
            : "w-full border-b md:h-screen md:w-14 md:border-b-0"
        }`}
      >
        <div
          className={`flex shrink-0 items-center gap-2 border-b-2 border-zinc-400/35 px-2 py-2.5 md:border-b-0 ${playlistSidebarOpen ? "" : "justify-center md:justify-start"}`}
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
                className="shrink-0 rounded-lg border border-zinc-600 bg-zinc-900/60 p-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
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
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 hover:text-white md:mx-auto md:h-10 md:w-10 md:gap-0 md:px-0 md:text-lg"
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
              <p className="text-xs uppercase tracking-wide text-zinc-400">Visual playlist editor</p>
              <ExpandableHelp label="Editor basics" variant="compact" className="mt-2">
                <p>
                  Use <strong>In player file</strong> to match what your IPTV app loads today, or <strong>Hidden by rules</strong> to
                  see channels the server stripped on the last refresh. Filters, order, and checkboxes{" "}
                  <strong>save automatically</strong>.
                </p>
              </ExpandableHelp>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="rounded-lg border border-zinc-600 bg-zinc-900/50 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800" to="/">
                Main app
              </Link>
              <button
                type="button"
                onClick={() => void signOut(auth)}
                className="rounded-lg border border-zinc-600 bg-zinc-900/50 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                Sign out
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-zinc-600/60 bg-zinc-950/45 p-3 ring-1 ring-white/[0.04]">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Rebuild player file (providers)</p>
                <p className="mt-1 text-[11px] leading-snug text-zinc-500">
                  Calls your M3U/Xtream sources on the server. Use “Reload table” below if you only need the editor view refreshed.
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  <div className="flex w-full items-start gap-0.5">
                    <button
                      type="button"
                      disabled={busy || serverReportsRefreshInFlight}
                      onClick={() => void rebuildM3u()}
                      title={
                        serverReportsRefreshInFlight
                          ? "The server is already rebuilding this playlist — wait for it to finish, or watch the status line below."
                          : "Re-downloads all sources from scratch; clears any Xtream checkpoint."
                      }
                      className="min-w-0 flex-1 rounded-lg bg-emerald-500 px-2 py-2.5 text-left text-sm font-semibold leading-snug text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                    >
                      {serverReportsRefreshInFlight ? (
                        "Continue loading…"
                      ) : (
                        <>
                          <span className="block">Full rebuild — all sources</span>
                          <span className="mt-0.5 block text-[11px] font-normal text-emerald-950/85">Clears checkpoint · starts over</span>
                        </>
                      )}
                    </button>
                    <InlineHelp text="Re-downloads every source, merges, applies rules, overwrites the hosted M3U. Large Xtream lists can take many minutes." />
                  </div>
                  {refreshResume ? (
                    <div className="rounded-lg border border-amber-600/45 bg-amber-950/25 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">Resume interrupted Xtream</p>
                      <p className="mt-1 text-[11px] leading-snug text-amber-100/90">
                        Saved through row <span className="font-mono">{refreshResume.skipEmitFirst.toLocaleString()}</span> (source #
                        {refreshResume.sourceIndex + 1}).
                      </p>
                      <button
                        type="button"
                        disabled={busy || serverReportsRefreshInFlight}
                        onClick={() => void rebuildM3u({ resume: true })}
                        title="Continues the Xtream catalog from the saved row; does not re-fetch earlier sources from scratch."
                        className="mt-1.5 w-full rounded-lg border border-amber-500/70 bg-amber-600/20 px-2 py-2 text-left text-xs font-semibold text-amber-50 hover:bg-amber-600/30 disabled:opacity-40"
                      >
                        <span className="block">Resume from checkpoint</span>
                        <span className="mt-0.5 block text-[10px] font-normal text-amber-100/80">Not a full rebuild — skips already-merged rows</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              {refreshProgress ? (
                <p className="text-center text-xs leading-snug text-amber-200/90" aria-live="polite">
                  {formatRefreshProgressLine(refreshProgress)}
                </p>
              ) : null}
              <p className="text-center text-[11px] text-zinc-400" aria-live="polite">
                {rulesAutosaveState === "saving" ? (
                  <span className="text-sky-300/90">Saving…</span>
                ) : rulesAutosaveState === "saved" ? (
                  <span className="text-emerald-300/90">Saved</span>
                ) : (
                  <span>Rules save automatically</span>
                )}
              </p>
              <div className="rounded-xl border border-zinc-600/50 bg-zinc-900/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Editor only (no Xtream / M3U fetch)</p>
                <div className="mt-2 flex w-full items-center gap-0.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void load()}
                    title="Re-downloads the channel table from Firebase for the current view only. Does not call your IPTV provider."
                    className="min-w-0 flex-1 rounded-lg border border-zinc-600 px-2 py-2.5 text-sm leading-snug hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Reload table from server
                  </button>
                  <InlineHelp text="Refreshes this page’s channel list from the last built player file (or rules-dropped snapshot). Does not hit Xtream or M3U URLs — use Full rebuild for that." />
                </div>
              </div>
            </div>
            {publicToken ? (
              <div className="rounded-lg border-2 border-zinc-300/35 bg-zinc-900/85 p-3 shadow-md ring-1 ring-zinc-950/30">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Player URL</p>
                <code className="mt-1 block break-all text-[11px] leading-snug text-emerald-200">{publicPlaylistUrl(publicToken)}</code>
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden pb-[env(safe-area-inset-bottom,0px)]">
        <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border-2 border-zinc-300/40 bg-zinc-800 p-3 shadow-lg shadow-black/30 ring-1 ring-zinc-950/30">
          {(["all", "tv", "movie", "series"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t ? "bg-emerald-500 text-emerald-950" : "bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
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
          <span className="ml-auto text-xs text-zinc-400">
            {listLoading ? <span className="mr-2 text-sky-400/90">Updating list…</span> : null}
            {editorHydrationDoc &&
            editorHydrationDoc.state === "running" &&
            editorFilterKey &&
            editorHydrationDoc.filterKey === editorFilterKey &&
            editorHydrationDoc.dataSet === (editorDataSet === "rulesDropped" ? "rulesDropped" : "player") ? (
              <span className="mr-2 text-zinc-400/90" aria-live="polite">
                Indexing editor cache{" "}
                {editorHydrationDoc.indexedThrough.toLocaleString()}
                {typeof editorHydrationDoc.filteredTotal === "number"
                  ? ` / ${editorHydrationDoc.filteredTotal.toLocaleString()}`
                  : "…"}
              </span>
            ) : null}
            Loaded {rows.length.toLocaleString()} / {total.toLocaleString()}{" "}
            {editorDataSet === "rulesDropped" ? "hidden rows" : "rows"}
            {editorDataSet === "player" && excludedCount > 0 && !showExcluded ? ` · ${excludedCount} hidden by rules (preview)` : ""}
            {editorDataSet === "player" && showExcluded ? " · showing rules preview (excluded only)" : ""}
            {editorDataSet === "rulesDropped" ? " · last refresh snapshot" : ""}
            {enrichEnabled ? " · enrichment on" : ""}
          </span>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border-2 border-zinc-300/40 bg-zinc-800 p-3 shadow-md ring-1 ring-zinc-950/28 sm:flex-row sm:flex-wrap sm:items-center">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Data source</span>
          <div className="flex flex-wrap gap-1 rounded-lg border-2 border-zinc-300/35 bg-zinc-900/90 p-0.5 shadow-inner">
            <button
              type="button"
              onClick={() => setEditorDataSet("player")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                editorDataSet === "player" ? "bg-emerald-500 text-emerald-950" : "text-zinc-300 hover:bg-zinc-700 hover:text-white"
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
                  : "text-zinc-300 hover:bg-zinc-700 hover:text-white"
              }`}
            >
              Hidden by rules (last rebuild)
            </button>
          </div>
          <ExpandableHelp label="What this data source means" variant="compact" className="sm:ml-auto sm:max-w-xl">
            <p>
              {editorDataSet === "player"
                ? "Table rows match the hosted M3U your IPTV app uses. The “hidden by rules” count is a live preview: rows still in the file that your saved rules would remove before the next refresh."
                : "Rows the server removed when it last built the player file. Select any you want back and tap Include again to add allow patterns, then refresh the player file."}
            </p>
          </ExpandableHelp>
        </div>

        <div className="flex flex-wrap gap-6 rounded-xl border-2 border-zinc-300/40 bg-zinc-800/95 px-4 py-3 text-sm text-zinc-100 shadow-md ring-1 ring-zinc-950/28">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={enrichEnabled} onChange={(e) => setEnrichEnabled(e.target.checked)} />
            TMDB enrichment (next rebuild)
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={dupLatest} onChange={(e) => setDupLatest(e.target.checked)} />
            Duplicate new into Latest
          </label>
        </div>

        <div className="rounded-xl border-2 border-zinc-300/40 bg-zinc-800 p-4 shadow-xl shadow-black/30 ring-1 ring-zinc-950/30">
          <div className="flex flex-col gap-1.5 border-b border-zinc-600/50 pb-4">
            <label className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-4">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-400">
                Search playlist
                {q.trim() !== serverQuery ? (
                  <span className="mt-0.5 block font-normal normal-case text-zinc-500">Typing…</span>
                ) : null}
              </span>
              <input
                className="min-w-0 flex-1 rounded-lg border-2 border-zinc-500/50 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 shadow-inner outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-400/35"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, group, or URL (server filter, pauses ~½s after you type)…"
                type="search"
                autoComplete="off"
                maxLength={LIMITS.MAX_EDITOR_SEARCH_CHARS}
              />
            </label>
          </div>

          <div className="pt-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Playlist tools</p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="hidden w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 sm:block">
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
                    <span className="flex items-center rounded-lg bg-zinc-800/90 px-2.5 py-1.5 text-xs font-medium tabular-nums text-zinc-200">
                      {selected.size.toLocaleString()} selected
                    </span>
                  ) : null}
                  <span className="hidden w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 sm:block">
                    Order
                  </span>
                  <div className={orgCluster}>
                    <button
                      type="button"
                      disabled={busy || !rules || selected.size === 0 || editorDataSet === "rulesDropped"}
                      onClick={() => moveSelectedChannelsToTop()}
                      title={
                        editorDataSet === "rulesDropped"
                          ? "Switch to “In player file” to reorder channels in the hosted M3U."
                          : "Puts selected channels first in each group (same as the context menu). Rules save automatically — refresh the player file when you want the hosted M3U to match."
                      }
                      className={orgBtnOutline}
                    >
                      {selected.size > 1
                        ? `Move ${selected.size.toLocaleString()} to top`
                        : "Move selected to top"}
                    </button>
                  </div>
                </div>

                {groupedVisible.length > 0 ? (
                  <>
                    <span className="hidden w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 sm:block">
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
                    <span className="hidden w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 sm:block">
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
                <span className="hidden w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 sm:block">
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
                      disabled={busy || listLoading}
                      onClick={() => void loadAllRemaining()}
                      title={`Fetches all remaining pages for the current category tab and search (up to ${LIMITS.MAX_CHANNELS_PER_PLAYLIST.toLocaleString()} channels in chunks of ${LIMITS.MAX_EDITOR_PAGE_SIZE.toLocaleString()}).`}
                      className={orgBtnSkySolid}
                    >
                      Load all channels
                    </button>
                    <ExpandableHelp label="What “Load all channels” does" variant="compact" className="max-w-xs text-right">
                      <p className="text-left">
                        Fetches each page from the server and appends rows until everything for this search and tab is shown.
                      </p>
                    </ExpandableHelp>
                  </div>
                ) : null}
              </div>
            </div>
            <ExpandableHelp label="Reorder & when changes hit your player" variant="compact" className="mt-3 border-t border-zinc-600/50 pt-3">
              <p>
                Drag the six-dot handle on a group bar or on a channel row. Group order and channel order live in your rules
                (auto-saved) — refresh the player file when you want the hosted M3U to match.
              </p>
            </ExpandableHelp>
          </div>
        </div>

        <div className="relative space-y-3" aria-busy={listLoading}>
          {groupedVisible.map(({ group, rows: gRows }) => {
            const allOn = gRows.length > 0 && gRows.every((r) => selected.has(r.id));
            const someOn = gRows.some((r) => selected.has(r.id)) && !allOn;
            const expanded = expandedGroups.has(group);
            return (
              <article
                key={group}
                className="overflow-hidden rounded-2xl border-2 border-zinc-300/40 bg-zinc-900/88 shadow-xl shadow-black/30 ring-1 ring-zinc-950/35"
              >
                <div
                  className="flex flex-wrap items-center gap-3 border-b-2 border-zinc-400/35 bg-gradient-to-r from-zinc-600 via-zinc-700 to-zinc-800 px-4 py-3"
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
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/50 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
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
                          className="inline-flex cursor-grab select-none items-center rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-1.5 py-1.5 text-zinc-500 hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-zinc-300 active:cursor-grabbing"
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
                    <span className="text-xs font-medium text-zinc-400">
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
                  <p className="px-4 py-3 text-center text-xs text-zinc-400">Collapsed — use the arrow to show channels.</p>
                )}
              </article>
            );
          })}
          {visible.length === 0 && !busy && !listLoading && (
            <p className="rounded-2xl border-2 border-dashed border-zinc-300/45 bg-zinc-700/80 py-12 text-center text-sm text-zinc-100 shadow-inner ring-1 ring-zinc-950/20">
              {editorDataSet === "rulesDropped" && total === 0
                ? "No “hidden by rules” snapshot for this playlist yet. Run “Full rebuild — all sources” once so the server can write it, or your rules may not have removed any channels on the last run."
                : "No channels match this tab or search."}
            </p>
          )}
        </div>

        <ExpandableHelp label="Tips: selection, rules, and refresh" variant="compact">
          <p>
            Use the group bar checkbox to select every channel in that group, or pick channels in the list. Use{" "}
            <strong>Move selected to top</strong> under Playlist tools (or right-click a channel row) to move the whole selection to
            the top of each group. Right-click a channel row or <strong>group bar</strong> for filters, or use <strong>Add a rule</strong>{" "}
            under Playlist tools. Drag the grip handle on a group or channel to reorder; rules save automatically, then{" "}
            <strong>refresh the player file</strong> so the hosted M3U matches.
            {editorDataSet === "player" && showExcluded
              ? " With excluded rows visible, “Include selected again” adds name/URL allow patterns for the selection — refresh the player file when ready."
              : editorDataSet === "rulesDropped"
                ? " On “Hidden by rules”, select rows and use Include again to add allow patterns, or edit excludes under Add a rule — then refresh the player file so apps pick up changes."
                : ""}
          </p>
        </ExpandableHelp>
        </div>
      </div>

      {menu && (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default bg-black/40" aria-label="Close menu" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 min-w-[200px] rounded-lg border-2 border-zinc-300/50 bg-zinc-800 py-1 shadow-2xl ring-2 ring-black/30"
            style={{
              left: Math.max(8, Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 216)),
              top: Math.max(8, Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 220)),
            }}
          >
            {menuIsMultiChannel ? (
              <p className="border-b border-zinc-600/50 px-3 py-2 text-xs leading-snug text-zinc-200">
                {selected.size.toLocaleString()} channels selected — order applies to the whole selection.
              </p>
            ) : null}
            {!menuIsMultiChannel ? (
              <>
                <p className="border-b border-zinc-600/50 px-3 py-1.5 text-xs text-zinc-400">Filter like this</p>
                <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-700" onClick={() => openFilterLike(menu.row, "name")}>
                  By channel title…
                </button>
                <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-700" onClick={() => openFilterLike(menu.row, "group")}>
                  By group name…
                </button>
                <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-700" onClick={() => openFilterLike(menu.row, "url")}>
                  By stream URL…
                </button>
                <div className="my-1 border-t border-zinc-600/50" />
              </>
            ) : null}
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Order</p>
            {menu.scope === "group" ? (
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-700"
                disabled={!rules}
                onClick={() => moveGroupToTopFromMenu()}
              >
                Move group to top of list
              </button>
            ) : (
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-700"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 p-3 sm:p-4">
          <div className="max-h-[min(90dvh,calc(100svh-2rem))] w-full max-w-2xl overflow-y-auto overscroll-y-contain rounded-2xl border-2 border-zinc-300/45 bg-zinc-800 shadow-2xl ring-2 ring-zinc-950/35">
            <div className="border-b-2 border-zinc-400/40 px-4 py-4 sm:px-5">
              <h2 className="text-lg font-semibold text-white">
                {filterModal.standalone ? "Add a playlist rule" : "Filter like this channel"}
              </h2>
              <ExpandableHelp label="How rules & preview interact" variant="compact" className="mt-2">
                <p>
                  Choose whether matching channels should be <strong>hidden</strong> or <strong>kept</strong>. The preview only looks
                  at rows <strong>already loaded in this table</strong>; after rules sync to the server, the same rule runs on the full
                  list when you rebuild.
                </p>
              </ExpandableHelp>
            </div>
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {filterModal.standalone ? (
                <div className="rounded-xl border-2 border-zinc-300/35 bg-zinc-900/80 p-3 shadow-inner">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Match on</p>
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
                            : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                        }`}
                      >
                        {fieldLabel(f)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border-2 border-zinc-300/35 bg-zinc-900/80 p-3 shadow-inner">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">From this row</p>
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
                        : "border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600"
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
                        : "border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-semibold text-white">Keep only matching channels</span>
                    <span className="mt-1 block text-xs text-zinc-500">Everything else is hidden (include / whitelist).</span>
                  </button>
                </div>
              </div>

              <div className="flex rounded-lg border-2 border-zinc-300/35 bg-zinc-950/70 p-1 shadow-inner">
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
                    filterModal.patternEditor === "simple" ? "bg-zinc-600 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Simple
                </button>
                <button
                  type="button"
                  onClick={() => setFilterModal({ ...filterModal, patternEditor: "advanced" })}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                    filterModal.patternEditor === "advanced" ? "bg-zinc-600 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
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
                      className="mt-1 w-full rounded-lg border-2 border-zinc-500/50 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
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
                              : "border-zinc-700 bg-zinc-900/60 hover:border-zinc-600"
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
                    className="h-24 w-full rounded-lg border-2 border-zinc-500/50 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
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

              <div className="rounded-xl border-2 border-zinc-300/35 bg-zinc-900/75 p-3 shadow-inner">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Preview in this table</p>
                  <p className="text-sm text-zinc-300">
                    <span className="text-emerald-400">{previewMatches.length}</span>{" "}
                    <span className="text-zinc-500">loaded row{previewMatches.length === 1 ? "" : "s"} match</span>
                  </p>
                </div>
                <div className="mt-2 max-h-48 overflow-auto rounded-lg border-2 border-zinc-400/40 bg-zinc-950/80 p-2 text-xs text-zinc-200">
                  {filterPatternIssue ? (
                    <p className="py-4 text-center text-zinc-500">Fix the pattern to see matching channels here.</p>
                  ) : previewMatches.length === 0 ? (
                    <p className="py-4 text-center text-zinc-500">No loaded rows match yet — try another style or edit the text.</p>
                  ) : (
                    previewMatches.slice(0, 80).map((r) => (
                      <div key={r.id} className="flex items-start gap-2 border-b border-zinc-600/35 py-2 last:border-0">
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
            <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-600/50 px-4 py-4 sm:px-5">
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
        <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-[60] max-w-[min(calc(100vw-1.5rem),28rem)] -translate-x-1/2 rounded-full border-2 border-zinc-300/55 bg-zinc-600 px-4 py-3 text-center text-sm leading-snug text-white shadow-2xl shadow-black/40 ring-2 ring-white/25 sm:py-2">
          {toast}
        </div>
      )}
    </div>
  );
}
