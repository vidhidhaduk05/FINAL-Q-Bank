# Q-Bank Sync Proxy (Cloudflare Worker)

A tiny serverless proxy that holds your GitHub token **server-side** so the browser
app never sees it. Once deployed, you paste the Worker URL into the app's Settings
tab and sync works on **every device** with no per-device token entry.

## What it does
- `GET /`  → reads `user_progress.json` from the `progress-data` branch, returns `{ ok, progress, sha }`.
- `PUT /`  ← `{ progress, sha }` → writes it back to GitHub, returns `{ ok, sha }`.
- Creates the `progress-data` branch automatically if it does not exist.
- Adds CORS headers so your GitHub Pages site can call it.

The token (`GH_TOKEN`) is a Worker **secret** — it is never returned to the browser
and is not in the app source.

---

## Deploy — Option A: Cloudflare dashboard (no install)

1. Sign up / log in at **https://dash.cloudflare.com** (free plan is fine).
2. **Workers & Pages → Create application → Create Worker.**
3. Name it `qbank-sync` → **Deploy** (creates a starter Worker).
4. Click **Edit code**, delete the starter, paste the contents of `sync-worker.js`, → **Save and deploy**.
5. **Settings → Variables and Secrets** → add:
   | Type | Name | Value |
   |------|------|-------|
   | Secret | `GH_TOKEN` | your fine-grained GitHub PAT (Contents: read & write on FINAL-Q-Bank) |
   | Text | `OWNER` | `vidhidhaduk05` |
   | Text | `REPO` | `FINAL-Q-Bank` |
   | Text | `BRANCH` | `progress-data` |
   | Text | `PATH` | `user_progress.json` |
   | Text | `ALLOWED_ORIGIN` | `https://vidhidhaduk05.github.io` |
6. Save. Your Worker URL is shown at the top, e.g. `https://qbank-sync.<your-subdomain>.workers.dev`.

> Use a **fresh** PAT (Contents: read & write, scoped to FINAL-Q-Bank only). Do not reuse a token you have pasted anywhere else.

## Deploy — Option B: wrangler CLI

```bash
cd worker
npx wrangler deploy            # uses wrangler.toml vars
npx wrangler secret put GH_TOKEN   # paste your PAT when prompted
```

---

## Connect the app
1. Open the app → **Settings** tab.
2. Paste the Worker URL into **Sync Proxy URL**.
3. **Save Settings** → **Test Connection** (should say "Proxy connected").
4. Done. Every "Done" toggle / note edit auto-syncs; every page load pulls remote first.

## Security notes
- The token lives only in Cloudflare (server-side). The browser and the public Pages site never receive it.
- The Worker only ever touches `user_progress.json` on the `progress-data` branch — it cannot access other files or branches.
- `ALLOWED_ORIGIN` restricts which site can call it; set it to your Pages origin. (`*` allows any origin — fine for a personal study app, but tighter is better.)
- Anyone who knows the Worker URL could read/write your progress JSON. The data is non-sensitive (study checkboxes/notes); rotate the PAT if you ever want to lock it down further.
