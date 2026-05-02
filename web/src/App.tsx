import { useCallback, useEffect, useMemo, useState } from "react";
import {
  User,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
} from "firebase/auth";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { auth, callable, db, getEmailLinkContinueUrl, publicPlaylistUrl } from "./firebase";

const EMAIL_LINK_STORAGE_KEY = "emailForSignIn";

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

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);

  const [srcLabel, setSrcLabel] = useState("");
  const [srcUrl, setSrcUrl] = useState("");

  const [plName, setPlName] = useState("My playlist");
  const [plSources, setPlSources] = useState<string[]>([]);

  const [selectedPl, setSelectedPl] = useState<string | null>(null);
  const [rulesJson, setRulesJson] = useState(defaultRulesJson);
  const [enrich, setEnrich] = useState(false);
  const [dupLatest, setDupLatest] = useState(true);
  const [diffText, setDiffText] = useState<string | null>(null);

  const selected = useMemo(() => playlists.find((p) => p.id === selectedPl) ?? null, [playlists, selectedPl]);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isSignInWithEmailLink(auth, window.location.href)) return;

    let cancelled = false;
    setCompletingLink(true);
    (async () => {
      try {
        let mail = localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
        if (!mail) {
          mail = window.prompt("Enter the same email address to complete sign-in")?.trim() ?? "";
        }
        if (!mail) throw new Error("Email is required to complete sign-in");
        await signInWithEmailLink(auth, mail, window.location.href);
        if (cancelled) return;
        localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
        window.history.replaceState({}, document.title, window.location.pathname);
        setToast("Signed in");
        setTimeout(() => setToast(null), 4200);
      } catch (e) {
        if (!cancelled) {
          setToast(e instanceof Error ? e.message : "Could not complete sign-in");
          setTimeout(() => setToast(null), 5200);
        }
      } finally {
        if (!cancelled) setCompletingLink(false);
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
      notify(e instanceof Error ? e.message : "Something went wrong");
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

  const logout = () => signOut(auth);

  const addSource = () =>
    run(async () => {
      const upsert = callable<{ label: string; url: string }, { id: string }>("upsertSource");
      await upsert({ label: srcLabel.trim() || "Source", url: srcUrl.trim() });
      setSrcUrl("");
      notify("Source saved (URL encrypted server-side)");
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
      const r = await c({ name: plName.trim() || "Playlist", sourceIds: plSources });
      setSelectedPl(r.data.id);
      notify("Playlist created — run Refresh to generate M3U");
    });

  const refreshPl = (id: string) =>
    run(async () => {
      const fn = callable<{ playlistId: string }, { ok: boolean; channelCount: number }>("refreshPlaylist");
      await fn({ playlistId: id });
      notify("Refresh complete");
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

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="font-display text-xl font-semibold text-white">Sources</h2>
          <p className="mt-1 text-sm text-zinc-400">URLs are encrypted at rest. They are never shown back in full.</p>
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
              Save source
            </button>
          </div>
          <ul className="mt-6 divide-y divide-zinc-800 rounded-xl border border-zinc-800">
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
          <h2 className="font-display text-xl font-semibold text-white">New playlist</h2>
          <p className="mt-1 text-sm text-zinc-400">Pick one or more sources (merged in order).</p>
          <input
            className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            value={plName}
            onChange={(e) => setPlName(e.target.value)}
          />
          <div className="mt-4 max-h-48 space-y-2 overflow-auto rounded-lg border border-zinc-800 p-2">
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
            {sources.length === 0 && <p className="text-sm text-zinc-500">Add a source first.</p>}
          </div>
          <button
            type="button"
            disabled={busy || plSources.length === 0}
            onClick={createPl}
            className="mt-4 w-full rounded-lg border border-emerald-700/60 bg-emerald-500/10 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            Create playlist
          </button>
        </section>

        <section className="lg:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="font-display text-xl font-semibold text-white">Playlists</h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-800">
              {playlists.map((p) => (
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
              {playlists.length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-500">No playlists yet</p>}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              {!selected && <p className="text-sm text-zinc-500">Select a playlist to edit.</p>}
              {selected && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => refreshPl(selected.id)}
                      className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                    >
                      Refresh now
                    </button>
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
                      Paste into your IPTV app as an M3U URL. First refresh generates the file.
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
