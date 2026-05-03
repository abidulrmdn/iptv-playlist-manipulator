import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  User,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
} from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import {
  auth,
  callable,
  db,
  getAuthEmulatorOobCodesListUrl,
  getEmailLinkContinueUrl,
  publicPlaylistUrl,
} from "./firebase";
import { formatRefreshProgressLine, type PlaylistRefreshProgress } from "./refreshProgressFormat";

const DEV_TEST_EMAIL = "test@test.com";

const EMAIL_LINK_STORAGE_KEY = "emailForSignIn";

/** Survives React Strict Mode remounts so we only consume the email link once. */
const EMAIL_LINK_OOB_GLOBAL = "__iptvListMgrEmailLinkOob";
type WindowWithOob = Window & { [EMAIL_LINK_OOB_GLOBAL]?: string };

function formatFunctionsDetails(details: unknown): string | undefined {
  if (typeof details === "string" && details.trim()) return details.trim();
  if (details && typeof details === "object" && "message" in details && typeof (details as { message: unknown }).message === "string") {
    const m = (details as { message: string }).message.trim();
    if (m) return m;
  }
  if (Array.isArray(details)) {
    const parts = details
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d === "object" && "message" in d && typeof (d as { message: unknown }).message === "string") {
          return (d as { message: string }).message;
        }
        return null;
      })
      .filter(Boolean) as string[];
    if (parts.length) return parts.join(" · ");
  }
  return undefined;
}

/** Native tooltip for short explanations next to actions (hover or long-press on touch). */
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

function formatFunctionsCustomData(customData: unknown): string | undefined {
  if (!customData || typeof customData !== "object") return undefined;
  const o = customData as Record<string, unknown>;
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  return undefined;
}

function clientErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const fe = e as Error & { code?: string; details?: unknown; customData?: unknown };
    const code = fe.code ?? "";
    if (code === "functions/deadline-exceeded") {
      return "That operation timed out (the server can take several minutes to download large M3Us). Try again, or use shorter source playlists.";
    }
    const msg = fe.message?.trim() ?? "";
    if (msg && !/^internal$/i.test(msg) && msg !== "deadline-exceeded") return msg;
    const fromDetails = formatFunctionsDetails(fe.details);
    if (fromDetails) return fromDetails;
    const fromCustom = formatFunctionsCustomData(fe.customData);
    if (fromCustom) return fromCustom;
    if (code.startsWith("functions/")) {
      const c = code.replace(/^functions\//, "");
      if (/^internal$/i.test(c)) {
        const onFnEmu = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === "true";
        return onFnEmu
          ? "Server error — check the Functions emulator terminal (common fix: valid ENCRYPTION_KEY in functions/.env, then restart emulators)."
          : "Server error — Gen2 callables run on Cloud Run. If Logs show “not authenticated” / empty Authorization, redeploy from this repo (invoker: public + predeploy IAM script) or run: npm run ensure-run-invoker -w functions (after gcloud auth). Also ensure you are signed in; then check Functions → Logs. Secret IPTV_ENCRYPTION_KEY is only needed for encryption errors, not for this IAM case.";
      }
      return c.replace(/-/g, " ");
    }
    return msg || "Something went wrong";
  }
  return "Something went wrong";
}

type SourceRow = { id: string; label: string; kind: "m3u" | "xtream"; createdAt?: { seconds?: number } };
type PlaylistRow = {
  id: string;
  name: string;
  publicToken: string;
  sourceIds: string[];
  rules: Record<string, unknown>;
  enrichEnabled?: boolean;
  duplicateNewIntoLatest?: boolean;
  channelCount?: number;
  etag?: string;
  lastError?: string;
  lastSuccessAt?: { seconds?: number };
  refreshProgress?: PlaylistRefreshProgress;
};

/** Written by the server after each successful rebuild; used for “what changed” in the UI. */
type DiffSummary = {
  previousCount: number;
  currentCount: number;
  newCount: number;
  removedApprox: number;
  updatedAt: string;
};

const defaultRulesJson = JSON.stringify(
  {
    dedupe: true,
    dedupeBy: "url",
    includeGroupPatterns: [] as string[],
    includeGroupPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    excludeGroupPatterns: [] as string[],
    excludeGroupPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    includeNamePatterns: [] as string[],
    includeNamePatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    excludeNamePatterns: [] as string[],
    excludeNamePatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    includeUrlPatterns: [] as string[],
    includeUrlPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    excludeUrlPatterns: [] as string[],
    excludeUrlPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    allowNamePatterns: [] as string[],
    allowNamePatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    allowUrlPatterns: [] as string[],
    allowUrlPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    allowGroupPatterns: [] as string[],
    allowGroupPatternScopes: [] as ("all" | "tv" | "movie" | "series")[],
    groupRenames: [] as { pattern: string; replacement: string }[],
    groupOrder: [] as string[],
    channelOrder: [] as string[],
    latestGroupName: "Latest fetch",
    newMarkerPrefix: "[NEW] ",
  },
  null,
  2,
);

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  /** Long M3U refresh must not block Step 1 (add sources) — `busy` is only for shorter callables. */
  const [playlistRefreshing, setPlaylistRefreshing] = useState(false);
  const [sourceSubmitting, setSourceSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);
  const [completingLink, setCompletingLink] = useState(false);
  const [devTestLoginUrl, setDevTestLoginUrl] = useState<string | null>(null);

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);

  const [srcLabel, setSrcLabel] = useState("");
  const [srcKind, setSrcKind] = useState<"m3u" | "xtream">("m3u");
  const [srcUrl, setSrcUrl] = useState("");
  const [xtBase, setXtBase] = useState("");
  const [xtUser, setXtUser] = useState("");
  const [xtPass, setXtPass] = useState("");
  /** Password managers / autofill often skip `onChange`; refs capture real DOM values on submit. */
  const srcUrlInputRef = useRef<HTMLInputElement>(null);
  const xtBaseInputRef = useRef<HTMLInputElement>(null);
  const xtUserInputRef = useRef<HTMLInputElement>(null);
  const xtPassInputRef = useRef<HTMLInputElement>(null);

  const [plName, setPlName] = useState("My playlist");
  const [plSources, setPlSources] = useState<string[]>([]);

  const [selectedPl, setSelectedPl] = useState<string | null>(null);
  /** Until Firestore snapshot includes a newly created playlist, keep a row so actions (e.g. refresh) still work. */
  const [pendingPlaylist, setPendingPlaylist] = useState<PlaylistRow | null>(null);
  const [rulesJson, setRulesJson] = useState(defaultRulesJson);
  const [enrich, setEnrich] = useState(false);
  const [dupLatest, setDupLatest] = useState(true);
  /** `undefined` = not loaded; `null` = no diff file yet; else parsed summary from Storage. */
  const [diffSummary, setDiffSummary] = useState<DiffSummary | null | undefined>(undefined);
  const [diffLoading, setDiffLoading] = useState(false);
  const [showAdvancedRulesJson, setShowAdvancedRulesJson] = useState(false);
  /** After switching playlists, skip one debounced save so we do not POST the same doc we just loaded. */
  const ignoreNextPlaylistAutosave = useRef(false);
  const lastSyncedPlaylistId = useRef<string | null>(null);
  const playlistAutosaveToken = useRef(0);
  const [playlistAutosaveState, setPlaylistAutosaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [rulesJsonBlocked, setRulesJsonBlocked] = useState(false);

  const selected = useMemo(() => {
    const fromFs = playlists.find((p) => p.id === selectedPl);
    if (fromFs) return fromFs;
    if (pendingPlaylist && pendingPlaylist.id === selectedPl) return pendingPlaylist;
    return null;
  }, [playlists, selectedPl, pendingPlaylist]);

  useEffect(() => {
    setPendingPlaylist((prev) => {
      if (!prev) return null;
      if (prev.id !== selectedPl) return null;
      if (playlists.some((p) => p.id === prev.id)) return null;
      return prev;
    });
  }, [selectedPl, playlists]);

  const displayPlaylists = useMemo(() => {
    if (!pendingPlaylist) return playlists;
    if (playlists.some((p) => p.id === pendingPlaylist.id)) return playlists;
    return [pendingPlaylist, ...playlists];
  }, [playlists, pendingPlaylist]);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const href = window.location.href;
    if (!isSignInWithEmailLink(auth, href)) return;

    let oobCode: string;
    try {
      oobCode = new URL(href).searchParams.get("oobCode") ?? "";
    } catch {
      return;
    }
    if (!oobCode) return;

    const w = window as WindowWithOob;
    if (w[EMAIL_LINK_OOB_GLOBAL] === oobCode) {
      window.history.replaceState({}, document.title, window.location.pathname);
      setCompletingLink(false);
      return;
    }
    w[EMAIL_LINK_OOB_GLOBAL] = oobCode;

    let cancelled = false;
    setCompletingLink(true);
    (async () => {
      try {
        let mail = localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
        if (!mail) {
          mail = window.prompt("Enter the same email address to complete sign-in")?.trim() ?? "";
        }
        if (!mail) throw new Error("Email is required to complete sign-in");
        await signInWithEmailLink(auth, mail, href);
        window.history.replaceState({}, document.title, window.location.pathname);
        localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
        delete w[EMAIL_LINK_OOB_GLOBAL];
        if (cancelled) return;
        setToast("Signed in");
        setTimeout(() => setToast(null), 4200);
      } catch (e) {
        delete w[EMAIL_LINK_OOB_GLOBAL];
        const code = typeof e === "object" && e && "code" in e ? String((e as { code: string }).code) : "";
        if (cancelled && code === "auth/invalid-action-code") {
          return;
        }
        if (!cancelled) {
          const msg =
            code === "auth/invalid-action-code"
              ? "Sign-in link expired or was already used. Request a new link."
              : e instanceof Error
                ? e.message
                : "Could not complete sign-in";
          setToast(msg);
          setTimeout(() => setToast(null), 5200);
        }
      } finally {
        setCompletingLink(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setSources([]);
      setPlaylists([]);
      return;
    }
    const q1 = query(collection(db, "sources"), where("ownerUid", "==", user.uid), orderBy("createdAt", "desc"));
    const unsub1 = onSnapshot(
      q1,
      (snap) => {
        setSources(
          snap.docs.map((d) => {
            const x = d.data() as { label?: string; kind?: string };
            const kind = x.kind === "xtream" ? "xtream" : "m3u";
            return {
              id: d.id,
              label: x.label ?? "",
              kind,
              createdAt: (d.data() as { createdAt?: { seconds?: number } }).createdAt,
            };
          }),
        );
      },
      (err) => {
        console.error("sources snapshot", err);
        setToast(
          `Could not load sources (${err.message}). If this mentions an index, deploy Firestore indexes and wait until they finish building.`,
        );
        setTimeout(() => setToast(null), 6200);
      },
    );
    const q2 = query(collection(db, "playlists"), where("ownerUid", "==", user.uid), orderBy("updatedAt", "desc"));
    const unsub2 = onSnapshot(
      q2,
      (snap) => {
        setPlaylists(
          snap.docs.map((d) => {
            const x = d.data() as Omit<PlaylistRow, "id"> & { refreshProgress?: unknown };
            const refreshProgress =
              x.refreshProgress &&
              typeof x.refreshProgress === "object" &&
              x.refreshProgress !== null &&
              "channelsSoFar" in x.refreshProgress
                ? (x.refreshProgress as PlaylistRefreshProgress)
                : undefined;
            const { refreshProgress: _rp, ...rest } = x;
            return { id: d.id, ...rest, refreshProgress };
          }),
        );
      },
      (err) => {
        console.error("playlists snapshot", err);
        setToast(`Could not load playlists (${err.message}).`);
        setTimeout(() => setToast(null), 6200);
      },
    );
    return () => {
      unsub1();
      unsub2();
    };
  }, [user]);

  useLayoutEffect(() => {
    if (!selectedPl) {
      lastSyncedPlaylistId.current = null;
      return;
    }
    if (!selected || selected.id !== selectedPl) return;
    if (lastSyncedPlaylistId.current === selectedPl) return;
    lastSyncedPlaylistId.current = selectedPl;
    ignoreNextPlaylistAutosave.current = true;
    setRulesJsonBlocked(false);
    setRulesJson(JSON.stringify(selected.rules ?? JSON.parse(defaultRulesJson), null, 2));
    setEnrich(Boolean(selected.enrichEnabled));
    setDupLatest(selected.duplicateNewIntoLatest !== false);
  }, [selectedPl, selected]);

  useEffect(() => {
    setDiffSummary(undefined);
    setDiffLoading(false);
  }, [selectedPl]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4200);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(clientErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendEmailLink = () =>
    run(async () => {
      const mail = email.trim();
      if (!mail) throw new Error("Enter your email");
      const url = getEmailLinkContinueUrl();
      if (!url) throw new Error("Could not build sign-in link URL");
      await sendSignInLinkToEmail(auth, mail, { url, handleCodeInApp: true });
      localStorage.setItem(EMAIL_LINK_STORAGE_KEY, mail);
      setLinkSent(true);
      notify("Check your email for the sign-in link");
    });

  /** Auth emulator does not send email; fetch the magic link from the emulator OOB API. */
  const generateDevTestLoginUrl = () =>
    run(async () => {
      const listUrl = getAuthEmulatorOobCodesListUrl();
      if (!listUrl) throw new Error("Dev login link only works with Vite dev + VITE_USE_EMULATOR=true");
      const continueUrl = getEmailLinkContinueUrl();
      if (!continueUrl) throw new Error("Could not build sign-in link URL");
      setDevTestLoginUrl(null);
      await sendSignInLinkToEmail(auth, DEV_TEST_EMAIL, { url: continueUrl, handleCodeInApp: true });
      localStorage.setItem(EMAIL_LINK_STORAGE_KEY, DEV_TEST_EMAIL);

      let oobLink: string | undefined;
      for (let i = 0; i < 12; i++) {
        const res = await fetch(listUrl);
        if (!res.ok) throw new Error(`Auth emulator OOB list failed (${res.status})`);
        const data = (await res.json()) as {
          oobCodes?: { requestType?: string; email?: string; oobLink?: string }[];
        };
        const codes = data.oobCodes ?? [];
        const match = [...codes].reverse().find(
          (o) => o.requestType === "EMAIL_SIGNIN" && o.email?.toLowerCase() === DEV_TEST_EMAIL,
        );
        if (match?.oobLink) {
          oobLink = match.oobLink;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!oobLink) throw new Error("No sign-in link from Auth emulator (running on 127.0.0.1:9099?)");
      setDevTestLoginUrl(oobLink);
      notify("Open the link below to finish sign-in");
    });

  const logout = () => signOut(auth);

  const addSource = () => {
    void (async () => {
      setSourceSubmitting(true);
      try {
        const u = auth.currentUser;
        if (!u) throw new Error("You are not signed in (or the session expired). Refresh the page and sign in again.");
        await u.getIdToken();
        const label = srcLabel.trim() || "Source";
        const upsert = callable<
          {
            label: string;
            sourceType?: string;
            url?: string;
            xtreamBaseUrl?: string;
            xtreamUsername?: string;
            xtreamPassword?: string;
          },
          { id: string }
        >("upsertSource");
        let kind: SourceRow["kind"] = "m3u";
        let data: { id: string };
        if (srcKind === "m3u") {
          const url = (srcUrlInputRef.current?.value ?? srcUrl).trim();
          if (!url) throw new Error("Enter a playlist URL");
          const r = await upsert({ label, sourceType: "m3u", url });
          data = r.data;
          setSrcUrl("");
          kind = "m3u";
        } else {
          const base = (xtBaseInputRef.current?.value ?? xtBase).trim();
          const xtreamUser = (xtUserInputRef.current?.value ?? xtUser).trim();
          const password = (xtPassInputRef.current?.value ?? xtPass).trim();
          if (!base) throw new Error("Enter the Xtream server URL (e.g. http://panel.example:8080)");
          if (!xtreamUser) throw new Error("Enter the Xtream username");
          if (!password) throw new Error("Enter the Xtream password");
          const r = await upsert({
            label,
            sourceType: "xtream",
            xtreamBaseUrl: base,
            xtreamUsername: xtreamUser,
            xtreamPassword: password,
          });
          data = r.data;
          setXtBase("");
          setXtUser("");
          setXtPass("");
          kind = "xtream";
        }
        setSources((prev) => {
          if (prev.some((s) => s.id === data.id)) return prev;
          return [{ id: data.id, label, kind, createdAt: { seconds: Math.floor(Date.now() / 1000) } }, ...prev];
        });
        notify(
          kind === "xtream"
            ? "Xtream source added (credentials encrypted server-side; refresh builds M3U from the API)"
            : "Source added (URL encrypted server-side)",
        );
      } catch (e) {
        notify(clientErrorMessage(e));
      } finally {
        setSourceSubmitting(false);
      }
    })();
  };

  const removeSource = (id: string) =>
    run(async () => {
      const del = callable<{ id: string }, { ok: boolean }>("deleteSource");
      await del({ id });
      notify("Source removed");
    });

  const createPl = () =>
    run(async () => {
      const c = callable<{ name: string; sourceIds: string[] }, { id: string; publicToken: string }>("createPlaylist");
      const name = plName.trim() || "Playlist";
      const sourceIds = [...plSources];
      const r = await c({ name, sourceIds });
      const id = r.data.id;
      setPendingPlaylist({
        id,
        name,
        publicToken: r.data.publicToken,
        sourceIds,
        rules: JSON.parse(defaultRulesJson) as Record<string, unknown>,
        enrichEnabled: false,
        duplicateNewIntoLatest: true,
      });
      setSelectedPl(id);
      notify("Playlist created — open it and use “Refresh player file from sources” (or the same control in the editor) once to generate the hosted M3U.");
    });

  const refreshPl = (id: string) => {
    void (async () => {
      if (!id) {
        notify(clientErrorMessage(new Error("No playlist selected")));
        return;
      }
      setPlaylistRefreshing(true);
      try {
        // Default callable timeout is 70s; refresh can take much longer (large M3Us + server limit 540s).
        const fn = callable<{ playlistId: string }, { ok: boolean; channelCount: number }>("refreshPlaylist", {
          timeout: 600_000,
        });
        await fn({ playlistId: id });
        notify("Player file updated — your player URL now serves the new merged M3U.");
      } catch (e) {
        notify(clientErrorMessage(e));
      } finally {
        setPlaylistRefreshing(false);
      }
    })();
  };

  useEffect(() => {
    if (!selectedPl || !selected || selected.id !== selectedPl) return;
    if (ignoreNextPlaylistAutosave.current) {
      ignoreNextPlaylistAutosave.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      let rules: Record<string, unknown>;
      try {
        rules = JSON.parse(rulesJson) as Record<string, unknown>;
        setRulesJsonBlocked(false);
      } catch {
        setRulesJsonBlocked(true);
        setPlaylistAutosaveState("idle");
        return;
      }
      const id = selectedPl;
      const token = ++playlistAutosaveToken.current;
      void (async () => {
        setPlaylistAutosaveState("saving");
        try {
          const u = callable<
            { id: string; rules: Record<string, unknown>; enrichEnabled: boolean; duplicateNewIntoLatest: boolean },
            { ok: boolean }
          >("updatePlaylist");
          await u({ id, rules, enrichEnabled: enrich, duplicateNewIntoLatest: dupLatest });
          if (token !== playlistAutosaveToken.current) return;
          setPlaylistAutosaveState("saved");
          window.setTimeout(() => {
            setPlaylistAutosaveState((s) => (s === "saved" ? "idle" : s));
          }, 2000);
        } catch (e) {
          if (token === playlistAutosaveToken.current) {
            setPlaylistAutosaveState("idle");
            notify(clientErrorMessage(e));
          }
        }
      })();
    }, 450);
    return () => window.clearTimeout(t);
  }, [rulesJson, enrich, dupLatest, selectedPl, selected?.id, notify]);

  const fetchDiff = (id: string) => {
    void (async () => {
      setDiffLoading(true);
      try {
        const fn = callable<{ playlistId: string }, { summary: unknown }>("getDiffSummary");
        const r = await fn({ playlistId: id });
        const raw = r.data.summary;
        if (raw == null) setDiffSummary(null);
        else setDiffSummary(raw as DiffSummary);
      } catch (e) {
        notify(clientErrorMessage(e));
      } finally {
        setDiffLoading(false);
      }
    })();
  };

  const rotate = (id: string) =>
    run(async () => {
      const fn = callable<{ playlistId: string }, { publicToken: string }>("rotatePlaylistToken");
      const r = await fn({ playlistId: id });
      notify(`New player URL issued — update your IPTV app. Old link no longer works (${r.data.publicToken.slice(0, 8)}…).`);
    });

  const removePl = (id: string) =>
    run(async () => {
      const fn = callable<{ playlistId: string }, { ok: boolean }>("deletePlaylist");
      await fn({ playlistId: id });
      if (selectedPl === id) setSelectedPl(null);
      notify("Playlist deleted");
    });

  if (!user) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-2xl backdrop-blur sm:p-8">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">IPTV List Manager</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Passwordless sign-in: we email you a link. New users are created automatically the first time they sign in.
          </p>
          {completingLink ? (
            <p className="mt-8 text-center text-sm text-zinc-300">Completing sign-in…</p>
          ) : (
            <>
              <label className="mt-6 block text-xs font-medium uppercase tracking-wide text-zinc-500">Email</label>
              <input
                className="mt-1 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none ring-emerald-500/40 focus:ring-2 sm:min-h-0 sm:py-2"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLinkSent(false);
                }}
                autoComplete="email"
                type="email"
                inputMode="email"
                placeholder="you@example.com"
              />
              <button
                type="button"
                disabled={busy || !email.trim()}
                onClick={sendEmailLink}
                className="mt-6 min-h-11 w-full rounded-lg bg-emerald-500 px-4 py-3 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50 sm:py-2.5"
              >
                Email me a sign-in link
              </button>
              {linkSent && (
                <p className="mt-4 text-sm text-zinc-400">
                  Link sent. Open it on this device for the smoothest flow, or use the same email in the prompt if you open
                  the link elsewhere.
                </p>
              )}
              {import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === "true" && (
                <div className="mt-8 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-amber-200/90">Local dev only</p>
                  <p className="mt-1 text-sm text-zinc-400">
                    One-time magic link for <span className="font-mono text-zinc-300">{DEV_TEST_EMAIL}</span> (Auth emulator
                    does not send email).
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={generateDevTestLoginUrl}
                    className="mt-3 w-full rounded-lg border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-100 hover:bg-amber-500/15 disabled:opacity-50"
                  >
                    Generate login link
                  </button>
                  {devTestLoginUrl && (
                    <div className="mt-3 space-y-2">
                      <a
                        href={devTestLoginUrl}
                        className="inline-block text-sm font-medium text-emerald-400 underline decoration-emerald-600/60 underline-offset-2 hover:text-emerald-300"
                      >
                        Open sign-in link
                      </a>
                      <p className="text-xs text-zinc-500">Or copy this URL:</p>
                      <code className="block max-h-24 overflow-auto break-all rounded-lg bg-zinc-950 p-2 text-[11px] leading-snug text-zinc-400">
                        {devTestLoginUrl}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {toast && <p className="mt-4 text-sm text-amber-300">{toast}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 pb-[max(4rem,env(safe-area-inset-bottom,1rem))]">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4 sm:py-4">
          <div className="min-w-0">
            <p className="font-display text-base font-semibold text-white sm:text-lg">IPTV List Manager</p>
            <p className="mt-0.5 text-xs text-zinc-500">Merge, dedupe, filters, EPG, optional TMDB</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="max-w-[min(100%,20rem)] truncate text-xs text-zinc-400 sm:max-w-none sm:text-sm">{user.email}</span>
            <button
              type="button"
              onClick={logout}
              className="min-h-10 shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 sm:py-1.5"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:space-y-8 sm:px-4 sm:py-8">
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4 text-sm leading-relaxed text-zinc-300 sm:p-5">
          <p className="font-medium text-zinc-100">How this screen is laid out</p>
          <ul className="mt-3 list-inside list-disc space-y-2 text-zinc-400 marker:text-zinc-600">
            <li>
              <span className="text-zinc-200">Top — your output playlists:</span> pick a hosted playlist, use{" "}
              <span className="text-zinc-200">Refresh player file from sources</span> when you want the server to pull fresh
              provider data, and copy the <strong className="font-normal text-zinc-300">player URL</strong> for your IPTV app.
            </li>
            <li>
              <span className="text-zinc-200">Below that — Step 1 (left):</span> paste each provider’s{" "}
              <strong className="font-normal text-zinc-300">raw M3U URL</strong>.{" "}
              <span className="text-zinc-200">Add to my sources</span> saves it to your pool.
            </li>
            <li>
              <span className="text-zinc-200">Step 2 (right):</span> tick sources, then{" "}
              <span className="text-zinc-200">Create merged playlist</span> for a{" "}
              <strong className="font-normal text-zinc-300">new</strong> hosted playlist (not the provider link).
            </li>
          </ul>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
          <h2 className="font-display text-lg font-semibold text-white sm:text-xl">Your output playlists</h2>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Pick a <strong className="font-medium text-zinc-300">hosted merged M3U</strong> below — settings and player link
            open in one full-width panel so you scroll less.
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Choose playlist</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {displayPlaylists.map((p) => {
                  const active = selectedPl === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={p.lastError ? p.lastError : undefined}
                      onClick={() => setSelectedPl(p.id)}
                      className={`max-w-full min-h-[3rem] rounded-xl border px-3 py-3 text-left transition sm:px-4 sm:py-2.5 ${
                        active
                          ? "border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/30"
                          : "border-zinc-700 bg-zinc-900/60 hover:border-zinc-600 hover:bg-zinc-800/80"
                      }`}
                    >
                      <span className="block truncate font-medium text-zinc-100">{p.name}</span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {p.channelCount != null ? `${p.channelCount} channels` : "Not generated yet"}
                        {p.lastError ? ` · Error` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              {displayPlaylists.length === 0 && (
                <p className="mt-2 rounded-xl border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-500">
                  No output playlists yet — add sources in Step 1, then create one in Step 2 below.
                </p>
              )}
            </div>

            {selected && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 sm:p-5">
                <div className="space-y-5">
                  <section className="rounded-lg border border-sky-900/35 bg-sky-950/10 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-400/90">Visual playlist editor</h3>
                    <p className="mt-1 text-sm text-zinc-400">
                      Browse channels from your <strong className="font-normal text-zinc-300">last successful server build</strong>,
                      drag to reorder, and add hide/show rules. Rules save automatically; use{" "}
                      <strong className="font-normal text-zinc-300">Refresh player file from sources</strong> below when you
                      want the hosted M3U to match. After each refresh you can still open channels removed by rules in the
                      editor under <strong className="font-normal text-zinc-300">Hidden by rules</strong>.
                    </p>
                    <Link
                      to={`organize/${selected.id}`}
                      className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-sky-600/50 bg-sky-500/15 px-4 py-3 text-sm font-medium text-sky-100 hover:bg-sky-500/25 sm:w-auto sm:py-2"
                    >
                      Open visual playlist editor
                    </Link>
                  </section>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Player URL</p>
                    <code className="mt-1 block max-h-40 overflow-auto break-all rounded-lg bg-zinc-900 p-3 text-xs text-emerald-200 sm:max-h-none">
                      {publicPlaylistUrl(selected.publicToken)}
                    </code>
                    <p className="mt-2 text-xs text-zinc-500">
                      Paste this URL into your IPTV app as the playlist address. It always points at the hosted file on this
                      service — not your raw provider links.
                    </p>
                  </div>

                  <section className="rounded-lg border border-emerald-900/40 bg-emerald-950/15 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-400/90">Hosted file &amp; history</h3>
                    <p className="mt-1 text-sm text-zinc-400">
                      Your IPTV app only downloads the hosted M3U. These actions talk to the server; large playlists can take
                      several minutes.
                    </p>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                      <div className="flex min-h-11 flex-wrap items-center gap-1">
                        <button
                          type="button"
                          disabled={busy || playlistRefreshing}
                          onClick={() => refreshPl(selected.id)}
                          className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                        >
                          Refresh player file from sources
                        </button>
                        <InlineHelp text="Downloads fresh M3U from each saved source, merges them, applies your rules and order, then overwrites the hosted file behind your player URL. Your app keeps the same URL and sees new channels after this finishes." />
                      </div>
                      {playlistRefreshing && selected.refreshProgress ? (
                        <p className="w-full text-sm text-amber-200/90" aria-live="polite">
                          {formatRefreshProgressLine(selected.refreshProgress)}
                        </p>
                      ) : null}
                      <div className="flex min-h-11 flex-wrap items-center gap-1">
                        <button
                          type="button"
                          disabled={diffLoading || playlistRefreshing}
                          onClick={() => fetchDiff(selected.id)}
                          className="rounded-lg border border-zinc-600 px-4 py-2.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
                        >
                          {diffLoading ? "Loading…" : diffSummary !== undefined ? "Refresh rebuild summary" : "Load rebuild summary"}
                        </button>
                        <InlineHelp text="Fetches a small JSON summary stored after each refresh: channel counts, approximate new lines vs the previous run, and approximate removals. Read-only — it does not change your playlist." />
                      </div>
                    </div>
                    {diffSummary === null && (
                      <p className="mt-3 text-sm text-zinc-500">
                        No summary yet — run <strong className="font-normal text-zinc-400">Refresh player file from sources</strong>{" "}
                        at least once. After the second refresh you will see new vs previous counts.
                      </p>
                    )}
                    {diffSummary != null && diffSummary !== undefined && (
                      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
                        <p className="text-xs text-zinc-500">
                          Snapshot time:{" "}
                          <span className="font-mono text-zinc-400">
                            {(() => {
                              try {
                                return new Date(diffSummary.updatedAt).toLocaleString();
                              } catch {
                                return diffSummary.updatedAt;
                              }
                            })()}
                          </span>
                        </p>
                        <ul className="mt-2 space-y-1.5 text-zinc-200">
                          <li>
                            Channels in merged playlist after this run:{" "}
                            <strong className="font-semibold text-white">{diffSummary.currentCount}</strong>
                          </li>
                          <li>
                            Channels that were not in the previous run (approx. “new” lines):{" "}
                            <strong className="font-semibold text-emerald-300">{diffSummary.newCount}</strong>
                          </li>
                          <li>
                            Lines that disappeared vs the previous run (approx.):{" "}
                            <strong className="font-semibold text-amber-200">{diffSummary.removedApprox}</strong>
                          </li>
                          <li className="text-zinc-400">
                            Previous run had <strong className="font-normal text-zinc-300">{diffSummary.previousCount}</strong>{" "}
                            channels (used only for comparison).
                          </li>
                        </ul>
                      </div>
                    )}
                  </section>

                  <div className="space-y-2 rounded-lg border border-zinc-800 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Playlist options</p>
                    <p className="text-xs text-zinc-500" aria-live="polite">
                      {playlistAutosaveState === "saving" ? (
                        <span className="text-sky-300/90">Saving…</span>
                      ) : playlistAutosaveState === "saved" ? (
                        <span className="text-emerald-300/90">Saved</span>
                      ) : rulesJsonBlocked ? (
                        <span className="text-amber-300/90">Auto-save paused — fix rules JSON so it parses.</span>
                      ) : (
                        <span>Rules and options here save automatically; they apply on the next refresh from sources.</span>
                      )}
                    </p>
                    <label className="flex cursor-pointer items-start gap-2 text-sm text-zinc-300">
                      <input type="checkbox" className="mt-1" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
                      <span>
                        Add TMDB descriptions to names (needs <code className="text-xs text-zinc-500">TMDB_API_KEY</code>{" "}
                        on Cloud Functions). Applies on the next rebuild.
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 text-sm text-zinc-300">
                      <input type="checkbox" className="mt-1" checked={dupLatest} onChange={(e) => setDupLatest(e.target.checked)} />
                      <span>
                        Also list newly detected channels under &quot;Latest fetch&quot; (duplicate row, same stream) so they are
                        easy to spot in the app.
                      </span>
                    </label>
                  </div>

                  <div className="rounded-lg border border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedRulesJson((o) => !o)}
                      className="flex min-h-11 w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-zinc-300 hover:bg-zinc-800/50"
                    >
                      <span>Advanced · edit rules as JSON</span>
                      <span className="text-xs text-zinc-500">{showAdvancedRulesJson ? "Hide" : "Show"}</span>
                    </button>
                    {showAdvancedRulesJson && (
                      <div className="border-t border-zinc-800 p-3">
                        <p className="mb-2 text-xs text-zinc-500">
                          Same data the visual editor edits: include/exclude regex lists, dedupe, group order, etc. Invalid JSON
                          pauses auto-save until the document parses.
                        </p>
                        {rulesJsonBlocked ? (
                          <p className="mb-2 text-xs text-amber-300/90">Fix the JSON below to resume saving.</p>
                        ) : null}
                        <label className="sr-only" htmlFor="rules-json">
                          Rules JSON
                        </label>
                        <textarea
                          id="rules-json"
                          className="h-48 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200 sm:h-56"
                          value={rulesJson}
                          onChange={(e) => setRulesJson(e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
                    <button
                      type="button"
                      disabled={busy || playlistRefreshing}
                      onClick={() => rotate(selected.id)}
                      className="min-h-10 w-full rounded-lg border border-amber-800/50 px-3 py-2.5 text-left text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-40 sm:w-auto sm:py-1.5"
                    >
                      New player link (invalidate old URL)
                    </button>
                    <button
                      type="button"
                      disabled={busy || playlistRefreshing}
                      onClick={() => removePl(selected.id)}
                      className="min-h-10 w-full rounded-lg border border-red-800/60 px-3 py-2.5 text-left text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40 sm:w-auto sm:py-1.5"
                    >
                      Delete playlist
                    </button>
                    <p className="w-full text-xs text-zinc-500">
                      <strong className="font-normal text-zinc-400">New player link</strong> — your IPTV app must use the new
                      URL; the old token stops working. Use if a link was leaked.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {!selectedPl && displayPlaylists.length > 0 && (
              <p className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/30 px-4 py-8 text-center text-sm text-zinc-500">
                Choose a playlist above to open the editor, refresh the hosted file, and copy the player URL.
              </p>
            )}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-600/90">Step 1 · Inputs</p>
            <h2 className="font-display mt-1 text-lg font-semibold text-white sm:text-xl">Your sources</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Add either an <strong className="font-medium text-zinc-300">M3U URL</strong> or{" "}
              <strong className="font-medium text-zinc-300">Xtream Codes</strong> (server URL + login). Secrets stay on
              the server (encrypted); refresh downloads or builds M3U on Firebase, then merges like any other source.
            </p>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-300">
                <input
                  type="radio"
                  name="srcKind"
                  className="accent-emerald-500"
                  checked={srcKind === "m3u"}
                  onChange={() => setSrcKind("m3u")}
                />
                M3U URL
              </label>
              <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-300">
                <input
                  type="radio"
                  name="srcKind"
                  className="accent-emerald-500"
                  checked={srcKind === "xtream"}
                  onChange={() => setSrcKind("xtream")}
                />
                Xtream Codes
              </label>
            </div>
            <div className="mt-4 space-y-3">
              <input
                placeholder="Label (e.g. Provider A)"
                className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
                value={srcLabel}
                onChange={(e) => setSrcLabel(e.target.value)}
              />
              {srcKind === "m3u" ? (
                <input
                  ref={srcUrlInputRef}
                  placeholder="https://…/playlist.m3u"
                  className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
                  value={srcUrl}
                  onChange={(e) => setSrcUrl(e.target.value)}
                  onInput={(e) => setSrcUrl(e.currentTarget.value)}
                />
              ) : (
                <>
                  <input
                    ref={xtBaseInputRef}
                    placeholder="Server URL (e.g. http://panel.example.com or http://host:8080)"
                    className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
                    value={xtBase}
                    onChange={(e) => setXtBase(e.target.value)}
                    onInput={(e) => setXtBase(e.currentTarget.value)}
                    autoComplete="off"
                  />
                  <input
                    ref={xtUserInputRef}
                    placeholder="Username"
                    className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
                    value={xtUser}
                    onChange={(e) => setXtUser(e.target.value)}
                    onInput={(e) => setXtUser(e.currentTarget.value)}
                    autoComplete="username"
                  />
                  <input
                    ref={xtPassInputRef}
                    placeholder="Password"
                    type="password"
                    className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
                    value={xtPass}
                    onChange={(e) => setXtPass(e.target.value)}
                    onInput={(e) => setXtPass(e.currentTarget.value)}
                    autoComplete="current-password"
                  />
                  <p className="text-xs text-zinc-500">
                    Use the same host you would put in an IPTV app for Xtream API (not the long M3U link). Live + VOD
                    are included; series are not.
                  </p>
                </>
              )}
              <button
                type="button"
                disabled={sourceSubmitting}
                onClick={addSource}
                className="min-h-11 w-full rounded-lg bg-emerald-500 py-3 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40 sm:py-2"
              >
                Add to my sources
              </button>
            </div>
            <p className="mt-3 text-xs text-zinc-500">Saved sources appear as checkboxes in step 2.</p>
            <ul className="mt-4 divide-y divide-zinc-800 rounded-xl border border-zinc-800">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                  <span className="min-w-0 flex-1 truncate text-zinc-200">
                    {s.kind === "xtream" && (
                      <span className="mr-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                        Xtream
                      </span>
                    )}
                    {s.label}
                  </span>
                  <button
                    type="button"
                    className="min-h-10 shrink-0 rounded-md px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 sm:py-1"
                    onClick={() => removeSource(s.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {sources.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-500">No sources yet</li>}
            </ul>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-sky-600/90">Step 2 · Output</p>
            <h2 className="font-display mt-1 text-lg font-semibold text-white sm:text-xl">Build a merged playlist from this app</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Choose which <strong className="font-medium text-zinc-300">saved sources</strong> (from Step 1) go into one{" "}
              <strong className="font-medium text-zinc-300">new output playlist</strong>. It appears in{" "}
              <strong className="font-medium text-zinc-300">Your output playlists</strong> above with its own player link —
              what you paste into your IPTV app, not the raw provider URLs.
            </p>
            <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">Output playlist name</label>
            <input
              className="mt-1 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm sm:min-h-0 sm:py-2"
              value={plName}
              onChange={(e) => setPlName(e.target.value)}
              placeholder="e.g. Living room merged"
            />
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-zinc-500">Sources to merge (order preserved)</p>
            <div className="mt-1 max-h-48 space-y-2 overflow-auto rounded-lg border border-zinc-800 p-2">
              {sources.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={plSources.includes(s.id)}
                    onChange={(e) => {
                      setPlSources((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                      );
                    }}
                  />
                  <span className="truncate">{s.label}</span>
                </label>
              ))}
              {sources.length === 0 && <p className="text-sm text-zinc-500">Add at least one source on the left first.</p>}
            </div>
            <button
              type="button"
              disabled={busy || playlistRefreshing || plSources.length === 0}
              onClick={createPl}
              className="mt-4 min-h-11 w-full rounded-lg border border-emerald-700/60 bg-emerald-500/10 py-3 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 sm:py-2"
            >
              Create merged playlist
            </button>
          </section>
        </div>
      </main>

      {toast && (
        <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-50 max-w-[min(calc(100vw-1.5rem),28rem)] -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-3 text-center text-sm leading-snug text-zinc-100 shadow-xl sm:py-2">
          {toast}
        </div>
      )}
    </div>
  );
}
