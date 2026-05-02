import { useCallback, useEffect, useMemo, useState } from "react";
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

const DEV_TEST_EMAIL = "test@test.com";

const EMAIL_LINK_STORAGE_KEY = "emailForSignIn";

/** Survives React Strict Mode remounts so we only consume the email link once. */
const EMAIL_LINK_OOB_GLOBAL = "__iptvListMgrEmailLinkOob";
type WindowWithOob = Window & { [EMAIL_LINK_OOB_GLOBAL]?: string };

function formatFunctionsDetails(details: unknown): string | undefined {
  if (typeof details === "string" && details.trim()) return details.trim();
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

function clientErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const fe = e as Error & { code?: string; details?: unknown };
    const code = fe.code ?? "";
    if (code === "functions/deadline-exceeded") {
      return "That operation timed out (the server can take several minutes to download large M3Us). Try again, or use shorter source playlists.";
    }
    const msg = fe.message?.trim() ?? "";
    if (msg && !/^internal$/i.test(msg) && msg !== "deadline-exceeded") return msg;
    const fromDetails = formatFunctionsDetails(fe.details);
    if (fromDetails) return fromDetails;
    if (code.startsWith("functions/")) {
      const c = code.replace(/^functions\//, "");
      if (/^internal$/i.test(c)) {
        return "Server error — check the Functions emulator terminal (common fix: valid ENCRYPTION_KEY in functions/.env, then restart emulators).";
      }
      return c.replace(/-/g, " ");
    }
    return msg || "Something went wrong";
  }
  return "Something went wrong";
}

type SourceRow = { id: string; label: string; createdAt?: { seconds?: number } };
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
};

const defaultRulesJson = JSON.stringify(
  {
    dedupe: true,
    dedupeBy: "url",
    includeGroupPatterns: [] as string[],
    excludeGroupPatterns: [] as string[],
    includeNamePatterns: [] as string[],
    excludeNamePatterns: [] as string[],
    includeUrlPatterns: [] as string[],
    excludeUrlPatterns: [] as string[],
    groupRenames: [] as { pattern: string; replacement: string }[],
    groupOrder: [] as string[],
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
  const [toast, setToast] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);
  const [completingLink, setCompletingLink] = useState(false);
  const [devTestLoginUrl, setDevTestLoginUrl] = useState<string | null>(null);

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);

  const [srcLabel, setSrcLabel] = useState("");
  const [srcUrl, setSrcUrl] = useState("");

  const [plName, setPlName] = useState("My playlist");
  const [plSources, setPlSources] = useState<string[]>([]);

  const [selectedPl, setSelectedPl] = useState<string | null>(null);
  /** Until Firestore snapshot includes a newly created playlist, keep a row so actions (e.g. refresh) still work. */
  const [pendingPlaylist, setPendingPlaylist] = useState<PlaylistRow | null>(null);
  const [rulesJson, setRulesJson] = useState(defaultRulesJson);
  const [enrich, setEnrich] = useState(false);
  const [dupLatest, setDupLatest] = useState(true);
  const [diffText, setDiffText] = useState<string | null>(null);

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
    const unsub1 = onSnapshot(q1, (snap) => {
      setSources(
        snap.docs.map((d) => {
          const x = d.data() as { label?: string };
          return { id: d.id, label: x.label ?? "", createdAt: (d.data() as { createdAt?: { seconds?: number } }).createdAt };
        }),
      );
    });
    const q2 = query(collection(db, "playlists"), where("ownerUid", "==", user.uid), orderBy("updatedAt", "desc"));
    const unsub2 = onSnapshot(q2, (snap) => {
      setPlaylists(
        snap.docs.map((d) => {
          const x = d.data() as Omit<PlaylistRow, "id">;
          return { id: d.id, ...x };
        }),
      );
    });
    return () => {
      unsub1();
      unsub2();
    };
  }, [user]);

  useEffect(() => {
    if (!selected) return;
    setRulesJson(JSON.stringify(selected.rules ?? JSON.parse(defaultRulesJson), null, 2));
    setEnrich(Boolean(selected.enrichEnabled));
    setDupLatest(selected.duplicateNewIntoLatest !== false);
  }, [selected]);

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

  const addSource = () =>
    run(async () => {
      const upsert = callable<{ label: string; url: string }, { id: string }>("upsertSource");
      await upsert({ label: srcLabel.trim() || "Source", url: srcUrl.trim() });
      setSrcUrl("");
      notify("Source added (URL encrypted server-side)");
    });

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
      notify("Playlist created — use Fetch & rebuild M3U to generate the player file");
    });

  const refreshPl = (id: string) =>
    run(async () => {
      if (!id) throw new Error("No playlist selected");
      // Default callable timeout is 70s; refresh can take much longer (large M3Us + server limit 540s).
      const fn = callable<{ playlistId: string }, { ok: boolean; channelCount: number }>("refreshPlaylist", {
        timeout: 600_000,
      });
      await fn({ playlistId: id });
      notify("M3U rebuilt from your sources");
    });

  const savePl = (id: string) =>
    run(async () => {
      let rules: Record<string, unknown>;
      try {
        rules = JSON.parse(rulesJson) as Record<string, unknown>;
      } catch {
        throw new Error("Rules JSON is invalid");
      }
      const u = callable<
        { id: string; rules: Record<string, unknown>; enrichEnabled: boolean; duplicateNewIntoLatest: boolean },
        { ok: boolean }
      >("updatePlaylist");
      await u({ id, rules, enrichEnabled: enrich, duplicateNewIntoLatest: dupLatest });
      notify("Playlist settings saved");
    });

  const fetchDiff = (id: string) =>
    run(async () => {
      const fn = callable<{ playlistId: string }, { summary: unknown }>("getDiffSummary");
      const r = await fn({ playlistId: id });
      setDiffText(JSON.stringify(r.data.summary, null, 2));
    });

  const rotate = (id: string) =>
    run(async () => {
      const fn = callable<{ playlistId: string }, { publicToken: string }>("rotatePlaylistToken");
      const r = await fn({ playlistId: id });
      notify(`New token issued (${r.data.publicToken.slice(0, 8)}…)`);
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
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-2xl backdrop-blur">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-white">IPTV List Manager</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Passwordless sign-in: we email you a link. New users are created automatically the first time they sign in.
          </p>
          {completingLink ? (
            <p className="mt-8 text-center text-sm text-zinc-300">Completing sign-in…</p>
          ) : (
            <>
              <label className="mt-6 block text-xs font-medium uppercase tracking-wide text-zinc-500">Email</label>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:ring-2"
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
                className="mt-6 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
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
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 pb-16">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div>
            <p className="font-display text-lg font-semibold text-white">IPTV List Manager</p>
            <p className="text-xs text-zinc-500">Milestone build — merge, dedupe, filters, EPG passthrough, optional TMDB</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-zinc-400 sm:inline">{user.email}</span>
            <button type="button" onClick={logout} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 text-sm leading-relaxed text-zinc-300">
          <p className="font-medium text-zinc-100">How this screen is laid out</p>
          <ul className="mt-3 list-inside list-disc space-y-2 text-zinc-400 marker:text-zinc-600">
            <li>
              <span className="text-zinc-200">Left — original M3U inputs:</span> paste each provider’s{" "}
              <strong className="font-normal text-zinc-300">raw M3U URL</strong>.{" "}
              <span className="text-zinc-200">Add to my sources</span> saves it; saved rows are the pool you pick from on
              the right.
            </li>
            <li>
              <span className="text-zinc-200">Right — your output playlist:</span> tick one or more saved sources, then{" "}
              <span className="text-zinc-200">Create merged playlist</span>. That becomes a{" "}
              <strong className="font-normal text-zinc-300">new hosted playlist</strong> this app builds (not the provider
              link). Below, open it and use <span className="text-zinc-200">Fetch & rebuild M3U</span> to pull sources and
              generate the M3U for your IPTV player.
            </li>
          </ul>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-600/90">Step 1 · Inputs</p>
            <h2 className="font-display mt-1 text-xl font-semibold text-white">Your source M3U URLs</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Each entry is one <strong className="font-medium text-zinc-300">original</strong> playlist URL from a
              provider. URLs are encrypted on the server and never shown back in full.
            </p>
            <div className="mt-4 space-y-3">
              <input
                placeholder="Label (e.g. Provider A)"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={srcLabel}
                onChange={(e) => setSrcLabel(e.target.value)}
              />
              <input
                placeholder="https://…/playlist.m3u"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                value={srcUrl}
                onChange={(e) => setSrcUrl(e.target.value)}
              />
              <button
                type="button"
                disabled={busy || !srcUrl.trim()}
                onClick={addSource}
                className="w-full rounded-lg bg-emerald-500 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                Add to my sources
              </button>
            </div>
            <p className="mt-3 text-xs text-zinc-500">Saved sources appear as checkboxes in step 2.</p>
            <ul className="mt-4 divide-y divide-zinc-800 rounded-xl border border-zinc-800">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
                  <span className="truncate text-zinc-200">{s.label}</span>
                  <button type="button" className="text-xs text-red-400 hover:text-red-300" onClick={() => removeSource(s.id)}>
                    Remove
                  </button>
                </li>
              ))}
              {sources.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-500">No sources yet</li>}
            </ul>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-sky-600/90">Step 2 · Output</p>
            <h2 className="font-display mt-1 text-xl font-semibold text-white">Build a merged playlist from this app</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Choose which <strong className="font-medium text-zinc-300">saved sources</strong> (from the left) go into
              one <strong className="font-medium text-zinc-300">new output playlist</strong>. That output gets its own
              player link below — this is what you paste into your IPTV app, not the raw provider URLs.
            </p>
            <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">Output playlist name</label>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
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
              disabled={busy || plSources.length === 0}
              onClick={createPl}
              className="mt-4 w-full rounded-lg border border-emerald-700/60 bg-emerald-500/10 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
            >
              Create merged playlist
            </button>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="font-display text-xl font-semibold text-white">Your output playlists</h2>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Each row is a <strong className="font-medium text-zinc-300">hosted merged M3U</strong> you manage here. Select
            one to fetch sources again, edit merge rules, and copy the <strong className="font-medium text-zinc-300">player URL</strong> for your IPTV app.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-800">
              {displayPlaylists.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPl(p.id)}
                  className={`flex w-full flex-col items-start gap-1 border-b border-zinc-800 px-4 py-3 text-left last:border-b-0 hover:bg-zinc-800/60 ${
                    selectedPl === p.id ? "bg-zinc-800/80" : ""
                  }`}
                >
                  <span className="font-medium text-zinc-100">{p.name}</span>
                  <span className="text-xs text-zinc-500">
                    {p.channelCount != null ? `${p.channelCount} channels` : "Not generated yet"}
                    {p.lastError ? ` · Error: ${p.lastError}` : ""}
                  </span>
                </button>
              ))}
              {displayPlaylists.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-zinc-500">No output playlists yet — create one above.</p>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              {!selectedPl && <p className="text-sm text-zinc-500">Select an output playlist from the list.</p>}
              {selected && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => refreshPl(selected.id)}
                      className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                    >
                      Fetch & rebuild M3U
                    </button>
                    <Link
                      to={`organize/${selected.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center rounded-lg border border-sky-700/50 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-500/15"
                    >
                      Open organizer
                    </Link>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => savePl(selected.id)}
                      className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Save rules
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => fetchDiff(selected.id)}
                      className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
                    >
                      Diff summary
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => rotate(selected.id)}
                      className="rounded-lg border border-amber-700/50 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
                    >
                      Rotate URL
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removePl(selected.id)}
                      className="rounded-lg border border-red-800/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Player URL</p>
                    <code className="mt-1 block break-all rounded-lg bg-zinc-900 p-3 text-xs text-emerald-200">
                      {publicPlaylistUrl(selected.publicToken)}
                    </code>
                    <p className="mt-2 text-xs text-zinc-500">
                      Paste into your IPTV app as an M3U URL. Use <span className="text-zinc-400">Fetch & rebuild M3U</span>{" "}
                      the first time (and whenever you want to pull fresh data from your sources).
                    </p>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
                    TMDB enrichment (requires <code className="text-xs text-zinc-400">TMDB_API_KEY</code> on Functions)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input type="checkbox" checked={dupLatest} onChange={(e) => setDupLatest(e.target.checked)} />
                    Duplicate “new” channels into Latest group (second line, same stream)
                  </label>

                  <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">Rules (JSON)</label>
                  <textarea
                    className="h-64 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
                    value={rulesJson}
                    onChange={(e) => setRulesJson(e.target.value)}
                  />

                  {diffText && (
                    <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                      {diffText}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
