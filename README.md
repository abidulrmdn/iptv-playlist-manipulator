# IPTV List Manager

A **Firebase** app that sits between IPTV providers and players: you add one or more **M3U URLs**, the backend **fetches, merges, dedupes, and filters** them, then serves a **single stable M3U URL** for your IPTV app. Provider URLs are **encrypted at rest**; the UI never shows them back in full.

---

## What’s implemented (shippable milestones)

| Milestone | Features |
|-----------|----------|
| **A** | Passwordless **email link** auth, **encrypted** sources, playlists with **ordered** sources, **rules JSON** (filters, dedupe, group renames, group order), **manual refresh**, output written to **Cloud Storage**, **public** HTTPS endpoint `publicPlaylist`, **daily** scheduled refresh (cost-capped batch), hard **limits** in `functions/src/constants.ts`. |
| **B** | Optional **TMDB** enrichment (playlist toggle + `TMDB_API_KEY` on Functions), TMDB attribution line in the M3U. |
| **C** | **Snapshot** `canonical-ids.json`, **`diff-summary.json`**, after the first snapshot **new** streams get a **`[NEW]`** prefix on `group-title`, optional **duplicate** row into **“Latest fetch”** (same stream URL). |

**Cost note (from product plan):** keep usage small (weekly/daily refresh, bounded playlist size). Set **Google Cloud budget alerts** on the Firebase/GCP project.

---

## Prerequisites

**Node.js 20+**, **npm**. Firebase CLI: use **`./node_modules/.bin/firebase`** after **`npm install`** (see `firebase-tools` in root `package.json`).

---

## Repository layout

| Path | Purpose |
|------|---------|
| `web/` | Vite + React + Tailwind SPA (Firebase Auth + Firestore reads + callable Functions). |
| `functions/` | Cloud Functions: callables (`upsertSource`, `createPlaylist`, `refreshPlaylist`, …), **`publicPlaylist`** (player M3U), **`scheduledPlaylistRefresh`**. |
| `firestore.rules` / `firestore.indexes.json` | Security rules + composite indexes for queries. |
| `storage.rules` | Deny all **client** Storage access; only the **Admin SDK** in Functions reads/writes playlist blobs. |
| `firebase.json` | Hosting, Functions, Firestore, Storage, emulator ports. |

---

## Run locally

**One command** (after first-time setup below):

```bash
make up
```

`make up` runs **`free-ports`** first (uses **`lsof`** + **`kill`** to clear listeners on the emulator/Vite ports from `Makefile`, then starts the stack). Same without Make: **`npm run up`** (does not free ports).

Starts **Firebase emulators** and **Vite** together (Ctrl+C stops both). Vite waits until the **Emulator UI** is up at **http://127.0.0.1:4000** so the stack is ready in one process group.

### First time only

1. **`npm install`**
2. **`functions/.env`** — copy [`functions/.env.example`](functions/.env.example), set `ENCRYPTION_KEY` from `openssl rand -base64 32` (optional: `TMDB_API_KEY`).
3. **`web/.env`** — copy [`web/.env.example`](web/.env.example). Paste Web config from Firebase **Project settings → Your apps → Web**. Set **`VITE_USE_EMULATOR=true`**. **`VITE_FIREBASE_PROJECT_ID`** must match **`.firebaserc`** `default`.

Then **`make up`** and open **http://localhost:5173** (Vite). In the app: register → add **https** M3U → playlist → **Refresh now** → **Player URL** (emulator: `http://127.0.0.1:5001/<PROJECT_ID>/us-central1/publicPlaylist?token=<token>`).

Unset **`GOOGLE_APPLICATION_CREDENTIALS`** if the Functions emulator warns about production APIs.

| Command | Description |
|---------|-------------|
| `make up` / `npm run up` | Emulators + Vite (local stack) |
| `npm install` | Workspaces + **firebase-tools** + **concurrently** |
| `npm run build` | Functions + `web/dist` |
| `npm run emulators` | Emulators only |
| `npm run dev -w web` | Vite only |

---

## Deploy to production

**Detailed checklist (IAM, budgets, troubleshooting):** **[docs/PRODUCTION.md](docs/PRODUCTION.md)**.

1. In [Firebase Console](https://console.firebase.google.com/): **Blaze** billing, **budget alerts**; enable **Authentication** (Email/Password provider with **Email link**), **Firestore**, **Storage**, **Functions**. Add your **Hosting / continue URL** domain under Auth → **Authorized domains** if needed.
2. **`web/.env`** — Web app config from Project settings, **`VITE_USE_EMULATOR=false`**, then `npm run build -w web`.
3. **`functions/.env`** — `ENCRYPTION_KEY` (required); optional `TMDB_API_KEY`. The CLI loads this when you run `firebase deploy` from this machine ([env docs](https://firebase.google.com/docs/functions/config-env)).
4. **`firebase login`** and **`firebase use <project-id>`** (see `.firebaserc`).
5. Deploy everything you need in one go:

   ```bash
   npm run build
   firebase deploy --only firestore:rules,firestore:indexes,storage,functions,hosting
   ```

6. If the **player M3U** returns **403**, open **Cloud Run** → **`publicPlaylist`** → allow **`allUsers`** as **Cloud Run Invoker** (Step 8 in [docs/PRODUCTION.md](docs/PRODUCTION.md)).

---

## Security notes

- **Sources / playlists** are not writable from the client in Firestore rules; writes go through **callable** Functions (Admin SDK).  
- **`playlistIndex`** (token → playlist id) is **not** readable or writable by clients.  
- **Storage** rules deny client read/write; only Functions read/write playlist files.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `ENCRYPTION_KEY is not set` | `functions/.env` locally, or Cloud env in production. |
| Firestore **permission denied** on snapshot listeners | Signed in? `ownerUid` on docs must match `request.auth.uid` (only applies to reads; writes are denied by design). |
| Callable **internal** on refresh | Emulator logs / Functions logs; upstream M3U URL must be reachable from the function (HTTPS, size under limit). |
| Player URL **403** in production | **Invoker** for `publicPlaylist` (see above). |
| Composite index error | Deploy `firestore.indexes.json` and open the link in the error to create any missing index. |
