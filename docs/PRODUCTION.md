# Production checklist (Firebase)

Use this in order for the full walkthrough (IAM, `gcloud`, TMDB, scheduler). The [README](../README.md) has a shorter **Deploy to production** summary.

Replace `iptv-playlist-manipulator` if your Firebase project id differs (see [`.firebaserc`](../.firebaserc)).

---

## Step 1 — Billing (Blaze)

1. Open [Firebase Console](https://console.firebase.google.com/) → your project.
2. **Build** (or gear) → **Usage and billing** → upgrade to **Blaze** if prompted.  
   **Why:** Cloud Functions that **fetch external HTTPS** (M3U URLs, TMDB) need outbound network; Spark blocks that.
3. In [Google Cloud Console → Billing → Budgets](https://console.cloud.google.com/billing/budgets), create **budget alerts** (e.g. notify at **$1** and **$5**).

---

## Step 2 — Enable Firebase products

In the same Firebase project:

| Product | Where | Action |
|--------|--------|--------|
| **Authentication** | Build → Authentication → Sign-in method | Enable **Email/Password** and turn on **Email link (passwordless sign-in)** in the same provider. |
| **Firestore** | Build → Firestore Database | **Create database** → production region you prefer (e.g. `nam5` / `us-central`). |
| **Storage** | Build → Storage | **Get started** → default bucket is fine. |
| **Functions** | Build → Functions | Complete any first-time setup wizard. |

---

## Step 3 — Web app config (for the React build)

1. Firebase Console → **Project settings** (gear) → **Your apps** → **Web** (`</>`) → register app if needed.
2. Copy the **Firebase JS SDK** config object.
3. On the machine you use to **build for production**, create or edit **`web/.env`** (do not commit):

   - Set all `VITE_FIREBASE_*` values from the console.
   - **Remove** `VITE_USE_EMULATOR` or set **`VITE_USE_EMULATOR=false`** so the app talks to **production** Auth/Firestore/Functions.

4. From repo root:

   ```bash
   npm run build -w web
   ```

---

## Step 4 — CLI: login and project

```bash
cd /path/to/iptv-list-manager
npm install
firebase login
firebase use iptv-playlist-manipulator
```

Confirm `.firebaserc` `default` matches this project id.

---

## Step 5 — Deploy Firestore rules, indexes, Storage rules

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

- If the CLI prints a **link to create a composite index**, open it and create the index, then redeploy or wait until the index is **enabled**.
- First deploy can take a few minutes.

---

## Step 6 — Functions environment variables

Functions read **`process.env.ENCRYPTION_KEY`** and optional **`TMDB_API_KEY`** (see `functions/src/crypto.ts` and `functions/src/index.ts`).

**Recommended for first deploy:** use a **`functions/.env`** file on the **same machine** that runs `firebase deploy` (keep it **out of git**; it is listed in `.gitignore`).

1. Generate a key (32 random bytes, base64):

   ```bash
   openssl rand -base64 32
   ```

2. Put it in **`functions/.env`**:

   ```env
   ENCRYPTION_KEY=paste_the_output_here
   # optional:
   # TMDB_API_KEY=your_tmdb_v3_read_token
   ```

3. **Important:** use **one** key for the lifetime of encrypted data in production. If you change `ENCRYPTION_KEY` later, existing encrypted source URLs in Firestore **cannot** be decrypted until users re-save each source.

The Firebase CLI loads **`functions/.env`** when you deploy Functions (see [Environment configuration](https://firebase.google.com/docs/functions/config-env)).

**Alternative (teams / CI):** store secrets in **Google Cloud Secret Manager** and attach them to each Cloud Run service (Gen2 function), or set **Runtime environment variables** in Cloud Console for each function—more work, same variable names.

---

## Step 7 — Build and deploy Functions + Hosting

```bash
npm run build
firebase deploy --only functions,hosting
```

- Watch the log for errors (APIs disabled, billing, etc.).
- After success, open **Firebase → Build → Functions** and confirm each function is listed (especially **`publicPlaylist`**).

---

## Step 8 — Allow the public M3U URL (required for IPTV apps)

IPTV players do **not** send Firebase Auth. **`publicPlaylist`** must allow **unauthenticated** access.

**Option A — Google Cloud Console**

1. [Cloud Run](https://console.cloud.google.com/run) → select project **iptv-playlist-manipulator**.
2. Find the service whose name matches **`publicplaylist`** (case may vary; Gen2 functions show as Cloud Run services).
3. **Security** (or **Permissions**) → **Add principal**:
   - Principal: **`allUsers`**
   - Role: **Cloud Run Invoker** (`roles/run.invoker`)

**Option B — gcloud** (replace region/service if the console shows different values):

```bash
gcloud run services add-iam-policy-binding publicplaylist \
  --region=us-central1 \
  --member=allUsers \
  --role=roles/run.invoker \
  --project=iptv-playlist-manipulator
```

If the service name differs, list services:

```bash
gcloud run services list --project=iptv-playlist-manipulator --region=us-central1
```

Without this step, the player URL returns **403**.

---

## Step 9 — Confirm production URLs

**Hosting (UI):** after deploy, the CLI prints a **Hosting URL** (often `https://iptv-playlist-manipulator.web.app`). Open it, register/sign in, add a source, create a playlist, **Refresh now**.

**Player M3U URL** (from your app UI, or manually):

```text
https://us-central1-iptv-playlist-manipulator.cloudfunctions.net/publicPlaylist?token=PUBLIC_TOKEN_FROM_FIRESTORE
```

If the Firebase / GCP UI shows a **different host** (some Gen2 setups use a `*.run.app` URL), use **that** host; keep the **`?token=`** query.

Sanity check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "https://us-central1-iptv-playlist-manipulator.cloudfunctions.net/publicPlaylist?token=INVALID"
```

You should get **404** (not **403**). A valid token after refresh should return **200** and `#EXTM3U`.

---

## Step 10 — Authentication authorized domains (if you add a custom domain)

Firebase Console → **Authentication** → **Settings** → **Authorized domains** → add your **custom domain** if you map it to Hosting.

---

## Step 11 — Scheduled refresh (optional verification)

`scheduledPlaylistRefresh` uses **Cloud Scheduler** + Pub/Sub in production. After first successful deploy, in GCP check **Cloud Scheduler** for a job tied to that function. If deploy asked to enable APIs, accept.

---

## Step 12 — Ongoing operations

| Task | Notes |
|------|--------|
| **Updates** | Change code → `npm run build` → `firebase deploy --only functions,hosting` (and rules if changed). |
| **Secrets** | Rotate `TMDB_API_KEY` in `functions/.env` (or Secret Manager) without breaking stored M3U URLs. Rotating **`ENCRYPTION_KEY`** breaks decryption of existing `urlEnc` data. |
| **Backups** | Use Firestore/Storage export policies if you care about user configs. |

---

## Quick reference

| Item | Value |
|------|--------|
| Project (your repo) | `iptv-playlist-manipulator` |
| Functions region (code) | `us-central1` |
| Required env | `ENCRYPTION_KEY` (base64, 32 bytes decoded) |
| Public HTTP function | `publicPlaylist` |
| Deploy rules/indexes/storage | `firebase deploy --only firestore:rules,firestore:indexes,storage` |
| Deploy app | `firebase deploy --only functions,hosting` |

For local development, see the main [README](../README.md).
