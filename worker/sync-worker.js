/**
 * Q-Bank Progress Sync Proxy — Cloudflare Worker
 * ===============================================
 * Holds your GitHub PAT server-side so the browser app never sees the token.
 * The app calls this Worker instead of the GitHub API directly; sync then
 * works on every device with zero per-device token entry.
 *
 * Endpoints:
 *   GET  /        -> { ok:true, progress:{...}, sha:"..." }   (read remote progress)
 *   PUT  /        <- { progress:{...}, sha:"..." }            (write remote progress)
 *                    -> { ok:true, sha:"..." }
 *   GET  /img/<slug>.<ext>  -> image bytes                    (read a note diagram)
 *   PUT  /img/<slug>.<ext>  <- raw image bytes                (upload a note diagram)
 *   OPTIONS /     -> CORS preflight
 *
 * Required environment (set via `wrangler secret` for the token, `wrangler deploy --var` or
 * the dashboard for the rest):
 *   GH_TOKEN         fine-grained GitHub PAT, Contents: read & write, scoped to this repo  [SECRET]
 *   OWNER            e.g. vidhidhaduk05
 *   REPO             e.g. FINAL-Q-Bank
 *   BRANCH           e.g. progress-data
 *   PATH             e.g. user_progress.json
 *   ALLOWED_ORIGIN   e.g. https://final-q-bank.vidhidhaduk05.workers.dev
 *                    (comma-separated list allowed, e.g. "https://a.dev,https://b.io"; "*" = any)
 */

const API = "https://api.github.com";

// ALLOWED_ORIGIN may be a single origin or a comma-separated list.
// CORS only permits one value, so we reflect the request Origin when it is on the list.
function resolveOrigin(env, reqOrigin) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(function (s) { return s.trim(); });
  if (allowed.indexOf("*") !== -1) return "*";
  if (reqOrigin && allowed.indexOf(reqOrigin) !== -1) return reqOrigin;
  return allowed[0] || "*";
}

function corsHeaders(env, reqOrigin) {
  return {
    "Access-Control-Allow-Origin": resolveOrigin(env, reqOrigin),
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, status, env, reqOrigin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(env, reqOrigin))
  });
}

function ghHeaders(env) {
  return {
    "Authorization": "Bearer " + env.GH_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "qbank-sync-worker",   // GitHub rejects API calls without a User-Agent (403)
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

// UTF-8 safe base64 (Workers run V8; btoa/atob operate on binary strings)
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob((b64 || "").replace(/\s/g, "")))); }

async function defaultBranchSha(env) {
  const r = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error("Repo lookup failed (HTTP " + r.status + "). Check OWNER/REPO/GH_TOKEN.");
  const repo = await r.json();
  const r2 = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO + "/git/refs/heads/" + repo.default_branch, { headers: ghHeaders(env) });
  if (!r2.ok) throw new Error("Default branch lookup failed (HTTP " + r2.status + ").");
  const ref = await r2.json();
  return ref.object.sha;
}

// Create BRANCH from the default branch if it does not yet exist.
async function ensureBranch(env) {
  const r = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO + "/git/refs/heads/" + env.BRANCH, { headers: ghHeaders(env) });
  if (r.ok) return;
  if (r.status !== 404) throw new Error("Branch check failed (HTTP " + r.status + ").");
  const sha = await defaultBranchSha(env);
  const r2 = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO + "/git/refs", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(env)),
    body: JSON.stringify({ ref: "refs/heads/" + env.BRANCH, sha: sha })
  });
  if (!r2.ok && r2.status !== 422) throw new Error("Branch create failed (HTTP " + r2.status + ").");
}

async function readProgress(env) {
  const url = API + "/repos/" + env.OWNER + "/" + env.REPO + "/contents/" + encodeURIComponent(env.PATH) +
              "?ref=" + encodeURIComponent(env.BRANCH);
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return { progress: {}, sha: null };          // no remote file yet -> start fresh
  if (!r.ok) {
    let detail = "";
    try { const t = await r.text(); detail = " Body: " + t.slice(0, 300); } catch (e) {}
    throw new Error("Pull failed (HTTP " + r.status + ")." + detail);
  }
  const data = await r.json();
  let progress = {};
  // For files > 1 MB, GitHub API returns encoding:"none" and empty content.
  // Fall back to download_url (raw.githubusercontent.com) to get the actual content.
  if (data.content && data.encoding === "base64") {
    try { progress = JSON.parse(b64decode(data.content)); } catch (e) { /* keep empty */ }
  } else if (data.download_url) {
    const r2 = await fetch(data.download_url, { headers: { "User-Agent": "qbank-sync-worker" } });
    if (r2.ok) {
      try { progress = JSON.parse(await r2.text()); } catch (e) { /* keep empty */ }
    }
  }
  return { progress: progress, sha: data.sha || null };
}

async function writeProgress(env, progress, sha) {
  await ensureBranch(env);
  const url = API + "/repos/" + env.OWNER + "/" + env.REPO + "/contents/" + encodeURIComponent(env.PATH);
  const body = {
    message: "Update Q-Bank progress (" + new Date().toISOString().slice(0, 19) + "Z)",
    content: b64encode(JSON.stringify(progress)),
    branch: env.BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(env)),
    body: JSON.stringify(body)
  });
  if (r.status === 409) throw new Error("Conflict — pull fresh copy first.");
  if (!r.ok && r.status !== 200 && r.status !== 201) {
    let msg = "Push failed (HTTP " + r.status + ").";
    try { const j = await r.json(); if (j.message) msg = j.message; } catch (e) {}
    throw new Error(msg);
  }
  const data = await r.json();
  return { sha: (data.content && data.content.sha) || null };
}

// --- Per-question diagram images (stored as notes/<id>.<ext> on BRANCH) ---
const IMG_RE = /^[A-Za-z0-9|_\-]+\.(png|jpe?g|gif|webp)$/i;

async function serveImage(env, name, reqOrigin) {
  if (!IMG_RE.test(name)) return json({ ok: false, error: "Invalid image name." }, 400, env, reqOrigin);
  const url = API + "/repos/" + env.OWNER + "/" + env.REPO + "/contents/notes/" + name +
              "?ref=" + encodeURIComponent(env.BRANCH);
  const r = await fetch(url, { headers: Object.assign({}, ghHeaders(env), { "Accept": "application/vnd.github.raw" }) });
  if (!r.ok) return json({ ok: false, error: "Image not found (HTTP " + r.status + ")." }, r.status === 404 ? 404 : 502, env, reqOrigin);
  const buf = await r.arrayBuffer();
  const ext = name.split(".").pop().toLowerCase();
  const ctMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const ct = ctMap[ext] || "image/png";
  return new Response(buf, {
    status: 200,
    headers: { "Content-Type": ct, "Cache-Control": "no-cache", "Access-Control-Allow-Origin": resolveOrigin(env, reqOrigin), "Vary": "Origin" }
  });
}

async function uploadImage(env, name, request, reqOrigin) {
  if (!IMG_RE.test(name)) return json({ ok: false, error: "Invalid image name." }, 400, env, reqOrigin);
  await ensureBranch(env);
  const buf = new Uint8Array(await request.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  const content = btoa(bin);
  // look up existing sha so we update in place
  let sha = null;
  const check = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO + "/contents/notes/" + name +
    "?ref=" + encodeURIComponent(env.BRANCH), { headers: ghHeaders(env) });
  if (check.ok) { const d = await check.json(); sha = d.sha; }
  const r = await fetch(API + "/repos/" + env.OWNER + "/" + env.REPO + "/contents/notes/" + name, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders(env)),
    body: JSON.stringify({ message: "Add diagram " + name, content: content, branch: env.BRANCH, sha: sha })
  });
  if (!r.ok && r.status !== 200 && r.status !== 201) {
    let msg = "Upload failed (HTTP " + r.status + ").";
    try { const j = await r.json(); if (j.message) msg = j.message; } catch (e) {}
    return json({ ok: false, error: msg }, 502, env, reqOrigin);
  }
  return json({ ok: true }, 200, env, reqOrigin);
}

export default {
  async fetch(request, env) {
    const method = request.method;
    const url = new URL(request.url);
    const path = url.pathname;
    const reqOrigin = request.headers.get("Origin");

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, reqOrigin) });
    }

    // Image routes: /img/<id>.<ext>
    if (path.indexOf("/img/") === 0) {
      const name = path.slice("/img/".length);
      try {
        if (method === "GET") return await serveImage(env, name, reqOrigin);
        if (method === "PUT") return await uploadImage(env, name, request, reqOrigin);
        return json({ ok: false, error: "Method not allowed for image." }, 405, env, reqOrigin);
      } catch (err) {
        return json({ ok: false, error: err.message }, 502, env, reqOrigin);
      }
    }

    try {
      if (method === "GET") {
        const out = await readProgress(env);
        return json({ ok: true, progress: out.progress, sha: out.sha }, 200, env, reqOrigin);
      }
      if (method === "PUT") {
        const payload = await request.json();
        if (!payload || typeof payload.progress !== "object") {
          return json({ ok: false, error: "Body must be { progress, sha }." }, 400, env, reqOrigin);
        }
        const out = await writeProgress(env, payload.progress, payload.sha || null);
        return json({ ok: true, sha: out.sha }, 200, env, reqOrigin);
      }
      return json({ ok: false, error: "Method not allowed." }, 405, env, reqOrigin);
    } catch (err) {
      return json({ ok: false, error: err.message }, 502, env, reqOrigin);
    }
  }
};
