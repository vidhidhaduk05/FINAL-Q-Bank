/* =========================================================================
   app.js — Medical Q-Bank SPA logic
   Static, framework-free. Loads questions_output.json, renders 7 tabs,
   tracks per-question done-state, and syncs progress to a GitHub repo
   via the Contents API (separate branch, no Pages rebuilds).
   ========================================================================= */
(function () {
  "use strict";

  /* ----------------------------- Constants ----------------------------- */
  var DATA_URL = "questions_output.json";
  var LS_PROGRESS = "qbank_progress";
  var LS_SETTINGS = "qbank_settings";
  var LS_THEME = "qbank_theme";
  var PAGE_SIZE = 24;
  var PUSH_DEBOUNCE_MS = 3000;
  var GH_API = "https://api.github.com";

  // Muted, colorblind-friendly palette (newspaper tones + accents)
  var PALETTE = [
    "#8b0000", "#2f2f2f", "#4a6c2f", "#b8860b",
    "#5a5a5a", "#8a6d3b", "#5b6b8a", "#a0522d",
    "#6a8e7b", "#9c6b4a", "#445566", "#7a5c8a"
  ];

  /* ----------------------------- State --------------------------------- */
  var state = {
    questions: [],
    progress: {},          // { "ENT|1": true, ... }
    settings: { proxyUrl: "", owner: "vidhidhaduk05", repo: "FINAL-Q-Bank", branch: "progress-data", path: "user_progress.json", token: "" },
    ghSha: null,           // sha of remote progress file (for update-in-place)
    ghDefaultBranch: null,
    tab: "dashboard",
    qFilters: { subject: "", topic: "", institution: "", year: "", stars: "0", type: "", is2026: false, search: "" },
    qPage: { page: 1 },
    impFilters: { is2026: false, search: "" },
    impPage: { page: 1 },
    charts: {},
    openSubjects: {},
    pushTimer: null,
    dirty: false,
    syncState: "offline",  // offline | pending | synced | error
    readerSubject: null,
    qMap: {}
  };

  /* ----------------------------- Helpers -------------------------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function starsStr(n) {
    if (!n) return "";
    var s = "";
    for (var i = 0; i < n; i++) s += "\u2605";
    return s;
  }
  function unique(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out.sort();
  }
  /* ---- Progress model: { id: { done, note, img } } (migrated from { id: true }) ---- */
  function migrateProgress() {
    var p = state.progress;
    for (var k in p) {
      if (p[k] === true) p[k] = { done: true, note: "", img: null };
      else if (p[k] && typeof p[k] === "object") {
        if (!("done" in p[k])) p[k].done = false;
        if (!("note" in p[k])) p[k].note = "";
        if (!("img" in p[k])) p[k].img = null;
      } else { delete p[k]; }   // false / null / junk
    }
  }
  function ensureProg(id) {
    var p = state.progress[id];
    if (!p || p === true) { p = { done: p === true, note: "", img: null }; state.progress[id] = p; }
    return p;
  }
  function isDone(q) { var p = state.progress[q.id]; return !!(p && p.done); }
  function getNote(id) { var p = state.progress[id]; return (p && p.note) || ""; }
  function getImg(id) { var p = state.progress[id]; return (p && p.img) || null; }
  function setDone(id, val) {
    var p = ensureProg(id);
    p.done = !!val;
    if (!p.done && !p.note && !p.img) delete state.progress[id];   // prune empties
  }
  function setNote(id, text) { ensureProg(id).note = text || ""; }
  function setImg(id, img) { ensureProg(id).img = img || null; }
  function toast(msg, kind) {
    var bar = $("statusBar");
    var t = el("div", "toast " + (kind || ""), esc(msg));
    bar.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, 3200);
  }

  /* ----------------------------- Persistence --------------------------- */
  function loadProgressLocal() {
    try { state.progress = JSON.parse(localStorage.getItem(LS_PROGRESS)) || {}; }
    catch (e) { state.progress = {}; }
    migrateProgress();
  }
  function saveProgressLocal() {
    try { localStorage.setItem(LS_PROGRESS, JSON.stringify(state.progress)); } catch (e) {}
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SETTINGS));
      if (s) state.settings = Object.assign(state.settings, s);
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
  }
  function ghConfigured() {
    var s = state.settings;
    // Proxy mode (token held server-side by the Worker) OR direct mode (owner+repo+token).
    return !!(s.proxyUrl || (s.owner && s.repo && s.token));
  }
  function usingProxy() { return !!state.settings.proxyUrl; }

  /* ----------------------------- Theme --------------------------------- */
  function applyTheme(theme) {
    if (theme === "dark") document.body.classList.add("dark");
    else document.body.classList.remove("dark");
    var btn = $("themeToggle");
    if (btn) btn.innerHTML = theme === "dark" ? "\u263C Light" : "\u263D Dark";
    // re-render charts to pick up theme colors
    if (state.questions.length) renderActiveTabCharts();
  }
  function toggleTheme() {
    var theme = document.body.classList.contains("dark") ? "light" : "dark";
    localStorage.setItem(LS_THEME, theme);
    applyTheme(theme);
  }

  /* ----------------------------- Sync indicator ------------------------ */
  function setSync(s) {
    state.syncState = s;
    var dot = $("syncDot"), lbl = $("syncLabel");
    if (!dot || !lbl) return;
    dot.className = "sync-dot " + s;
    lbl.textContent = ({
      offline: "Local", pending: "Saving\u2026", synced: "Synced", error: "Sync error"
    })[s] || "Local";
  }

  /* ----------------------------- GitHub API ---------------------------- */
  function ghHeaders() {
    var h = { "Accept": "application/vnd.github+json" };
    if (state.settings.token) h["Authorization"] = "Bearer " + state.settings.token;
    return h;
  }
  function ghContentsUrl(withRef) {
    var s = state.settings;
    var base = GH_API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo) +
      "/contents/" + encodeURIComponent(s.path);
    // GET supports ?ref= to read from a branch; PUT takes the branch in the body instead.
    return withRef ? base + "?ref=" + encodeURIComponent(s.branch) : base;
  }
  function b64encode(str) {
    // UTF-8 safe base64
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\s/g, ""))));
  }

  // Ensure the progress branch exists (create from default branch if missing)
  function ensureBranch() {
    var s = state.settings;
    return fetch(GH_API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo), { headers: ghHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("Repo not found (HTTP " + r.status + "). Check owner/repo/token.");
        return r.json();
      })
      .then(function (repo) {
        state.ghDefaultBranch = repo.default_branch;
        // check if branch exists
        return fetch(GH_API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo) +
          "/git/refs/heads/" + encodeURIComponent(s.branch), { headers: ghHeaders() });
      })
      .then(function (r) {
        if (r.ok) return null;            // branch exists
        if (r.status !== 404) throw new Error("Branch check failed (HTTP " + r.status + ").");
        // create branch from default branch head
        return fetch(GH_API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo) +
          "/git/refs/heads/" + encodeURIComponent(state.ghDefaultBranch), { headers: ghHeaders() })
          .then(function (r2) { if (!r2.ok) throw new Error("Default branch lookup failed."); return r2.json(); })
          .then(function (ref) {
            return fetch(GH_API + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo) +
              "/git/refs", {
                method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
                body: JSON.stringify({ ref: "refs/heads/" + s.branch, sha: ref.object.sha })
              });
          })
          .then(function (r3) {
            if (!r3.ok && r3.status !== 422) throw new Error("Branch create failed (HTTP " + r3.status + ").");
            return null;
          });
      });
  }

  function pullFromGitHub(silent) {
    if (!ghConfigured()) { if (!silent) toast("GitHub not configured.", "err"); return Promise.resolve(); }
    var req;
    if (usingProxy()) {
      // Proxy mode: Worker returns { ok, progress, sha } directly (no base64 / GitHub API).
      req = fetch(state.settings.proxyUrl, { headers: { "Accept": "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("Proxy pull failed (HTTP " + r.status + ")."); return r.json(); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || "Proxy pull error.");
          return { sha: res.sha || null, progress: res.progress || {}, fresh: false };
        });
    } else {
      // Direct mode: GitHub Contents API.
      req = fetch(ghContentsUrl(true), { headers: ghHeaders() })
        .then(function (r) {
          if (r.status === 404) { return { sha: null, progress: null, fresh: true }; }
          if (!r.ok) throw new Error("Pull failed (HTTP " + r.status + ").");
          return r.json().then(function (data) {
            var p = {};
            try { p = JSON.parse(b64decode(data.content || "")); } catch (e) {}
            return { sha: data.sha || null, progress: p, fresh: false };
          });
        });
    }
    return req
      .then(function (res) {
        state.ghSha = res.sha;
        if (res.progress) state.progress = Object.assign({}, state.progress, res.progress);
        migrateProgress();
        saveProgressLocal();
        setSync("synced");
        if (res.fresh) { if (!silent) toast("No remote progress yet \u2014 starting fresh.", "ok"); }
        else if (!silent) toast("Pulled progress from GitHub.", "ok");
        refreshAll();
      })
      .catch(function (err) {
        setSync("error");
        if (!silent) toast(err.message, "err");
      });
  }

  function pushToGitHub(silent) {
    if (!ghConfigured()) { saveProgressLocal(); setSync("offline"); return Promise.resolve(); }
    setSync("pending");
    var req;
    if (usingProxy()) {
      // Proxy mode: Worker handles branch creation + GitHub PUT; app sends plain progress + sha.
      req = fetch(state.settings.proxyUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress: state.progress, sha: state.ghSha })
      })
        .then(function (r) { if (!r.ok) throw new Error("Proxy push failed (HTTP " + r.status + ")."); return r.json(); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || "Proxy push error.");
          return { sha: res.sha || state.ghSha };
        });
    } else {
      // Direct mode: GitHub Contents API.
      req = ensureBranch()
        .then(function () {
          var body = {
            message: "Update Q-Bank progress (" + new Date().toISOString().slice(0, 19) + "Z)",
            content: b64encode(JSON.stringify(state.progress)),
            branch: state.settings.branch
          };
          if (state.ghSha) body.sha = state.ghSha;
          return fetch(ghContentsUrl(false), {
            method: "PUT",
            headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
            body: JSON.stringify(body)
          });
        })
        .then(function (r) {
          if (r.status === 409) throw new Error("Conflict \u2014 pulling fresh copy first.");
          if (!r.ok && r.status !== 201 && r.status !== 200) {
            return r.json().then(function (j) { throw new Error(j.message || ("Push failed HTTP " + r.status)); });
          }
          return r.json().then(function (data) { return { sha: (data && data.content && data.content.sha) || state.ghSha }; });
        });
    }
    return req
      .then(function (res) {
        state.ghSha = res.sha;
        state.dirty = false;
        setSync("synced");
        if (!silent) toast("Progress saved to GitHub.", "ok");
      })
      .catch(function (err) {
        setSync("error");
        if (!silent) toast(err.message, "err");
        // on conflict, pull then retry once
        if (/Conflict/.test(err.message)) {
          pullFromGitHub(true).then(function () { pushToGitHub(true); });
        }
      });
  }

  function schedulePush() {
    state.dirty = true;
    saveProgressLocal();
    setSync(ghConfigured() ? "pending" : "offline");
    if (state.pushTimer) clearTimeout(state.pushTimer);
    if (!ghConfigured()) return;
    state.pushTimer = setTimeout(function () { pushToGitHub(true); }, PUSH_DEBOUNCE_MS);
  }

  /* ----------------------------- Data loading -------------------------- */
  function loadData() {
    fetch(DATA_URL)
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load " + DATA_URL + " (HTTP " + r.status + ").");
        return r.json();
      })
      .then(function (data) {
        state.questions = data || [];
        // fast id -> question lookup for notes/reader
        state.qMap = {};
        for (var q = 0; q < state.questions.length; q++) state.qMap[state.questions[q].id] = state.questions[q];
        // seed progress from Excel "done" flags only if local progress empty
        if (Object.keys(state.progress).length === 0) {
          for (var i = 0; i < state.questions.length; i++) {
            if (state.questions[i].done) setDone(state.questions[i].id, true);
          }
          saveProgressLocal();
        }
        buildFilterOptions();
        renderDashboard();
        renderQuestions();
        renderImp();
        renderProgress();
        setSync(ghConfigured() ? "synced" : "offline");
        if (ghConfigured()) pullFromGitHub(true);
      })
      .catch(function (err) {
        var grid = $("qCardGrid");
        if (grid) grid.innerHTML = '<div class="empty-state">' + esc(err.message) + "</div>";
        toast(err.message, "err");
      });
  }

  /* ----------------------------- Tab routing --------------------------- */
  var TABS = ["dashboard", "questions", "reader", "probability", "imp", "progress", "analytics", "settings"];
  function showTab(tab) {
    state.tab = tab;
    TABS.forEach(function (t) {
      var sec = $("tab-" + t);
      if (sec) sec.classList.toggle("active", t === tab);
    });
    var navs = document.querySelectorAll("nav.masthead__nav a");
    navs.forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-tab") === tab); });
    // close mobile nav
    var mn = $("mastheadNav"); if (mn) mn.classList.remove("open");
    // lazy render
    if (tab === "reader") renderReader();
    renderActiveTabCharts();
    // scroll to top
    window.scrollTo(0, 0);
  }
  function renderActiveTabCharts() {
    if (state.tab === "probability") renderProbabilityCharts();
    if (state.tab === "analytics") renderAnalyticsCharts();
  }

  /* ----------------------------- Dashboard ----------------------------- */
  function renderDashboard() {
    var qs = state.questions;
    var total = qs.length;
    var subjects = unique(qs.map(function (q) { return q.subject; }));
    var instSet = {};
    qs.forEach(function (q) { q.sources.forEach(function (s) { instSet[s] = 1; }); });
    var institutions = Object.keys(instSet).sort();
    var doneCount = qs.filter(isDone).length;
    var pct = total ? Math.round((doneCount / total) * 100) : 0;
    var y2026 = qs.filter(function (q) { return q.is2026; }).length;

    var stats = $("dashStats");
    stats.innerHTML = "";
    var cards = [
      { label: "Total Questions", value: total.toLocaleString(), foot: "across the bank", cls: "" },
      { label: "Subjects", value: subjects.length, foot: subjects.length + " subject areas", cls: "" },
      { label: "Institutions", value: institutions.length, foot: "exam sources", cls: "" },
      { label: "Overall Progress", value: pct + "%", foot: doneCount.toLocaleString() + " / " + total.toLocaleString() + " done", cls: "accent" },
      { label: "2026 Exam Qs", value: y2026.toLocaleString(), foot: "flagged for 2026", cls: "" },
      { label: "IMP (★★/★★★)", value: qs.filter(function (q) { return q.stars >= 2; }).length, foot: "high importance", cls: "" }
    ];
    cards.forEach(function (c) {
      var card = el("div", "stat-card " + c.cls);
      card.innerHTML = '<div class="stat-label">' + esc(c.label) + "</div>" +
        '<div class="stat-value">' + c.value + "</div>" +
        '<div class="stat-foot">' + esc(c.foot) + "</div>";
      stats.appendChild(card);
    });

    // subject progress table
    var sp = $("dashSubjectProgress");
    sp.innerHTML = "";
    var head = el("div", "sp-row head");
    head.innerHTML = '<div class="sp-name">Subject</div><div class="col-remaining">Total</div><div>Done</div><div>Progress</div><div class="sp-pct">% Done</div>';
    sp.appendChild(head);
    subjects.forEach(function (subj) {
      var subset = qs.filter(function (q) { return q.subject === subj; });
      var d = subset.filter(isDone).length;
      var p = subset.length ? Math.round((d / subset.length) * 100) : 0;
      var row = el("div", "sp-row");
      row.innerHTML =
        '<div class="sp-name">' + esc(subj) + "</div>" +
        '<div class="col-remaining">' + subset.length + "</div>" +
        "<div>" + d + "</div>" +
        '<div class="progress-bar"><span style="width:' + p + '%"></span></div>' +
        '<div class="sp-pct">' + p + "%</div>";
      sp.appendChild(row);
    });
  }

  /* ----------------------------- Filter options ------------------------ */
  function buildFilterOptions() {
    var qs = state.questions;
    var subjects = unique(qs.map(function (q) { return q.subject; }));
    var institutions = unique([].concat.apply([], qs.map(function (q) { return q.sources; })));
    var years = unique([].concat.apply([], qs.map(function (q) { return q.years; })));
    var types = unique(qs.map(function (q) { return q.type; }));

    // Questions filter bar
    var fb = $("qFilters");
    fb.innerHTML = "";
    var opts = function (arr) {
      return '<option value="">All</option>' + arr.map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(v) + "</option>";
      }).join("");
    };
    fb.innerHTML =
      field("Subject", select("fSubject", opts(subjects))) +
      field("Topic", select("fTopic", '<option value="">All</option>')) +
      field("Institution", select("fInst", opts(institutions))) +
      field("Year", select("fYear", opts(years))) +
      field("Importance", select("fStars",
        '<option value="0">All</option><option value="3">★★★</option><option value="2">★★ &amp; up</option><option value="1">★ &amp; up</option>')) +
      field("Type", select("fType", opts(types))) +
      '<div class="field toggle-field"><label><input type="checkbox" id="f2026"> 2026 exam only</label></div>' +
      '<div class="field search"><label for="fSearch">Search question / topic</label>' +
      '<input type="text" id="fSearch" placeholder="e.g. asthma, cholesteatoma, myocardial\u2026"></div>' +
      '<div class="actions"><button class="btn small" id="qReset">Reset filters</button></div>';

    function field(label, control) {
      return '<div class="field"><label>' + esc(label) + "</label>" + control + "</div>";
    }
    function select(id, inner) {
      return '<select id="' + id + '">' + inner + "</select>";
    }

    // wire events
    $("fSubject").addEventListener("change", function () {
      state.qFilters.subject = this.value;
      state.qPage.page = 1;
      populateTopics(this.value);
      renderQuestions();
    });
    $("fTopic").addEventListener("change", function () {
      state.qFilters.topic = this.value; state.qPage.page = 1; renderQuestions();
    });
    $("fInst").addEventListener("change", function () {
      state.qFilters.institution = this.value; state.qPage.page = 1; renderQuestions();
    });
    $("fYear").addEventListener("change", function () {
      state.qFilters.year = this.value; state.qPage.page = 1; renderQuestions();
    });
    $("fStars").addEventListener("change", function () {
      state.qFilters.stars = this.value; state.qPage.page = 1; renderQuestions();
    });
    $("fType").addEventListener("change", function () {
      state.qFilters.type = this.value; state.qPage.page = 1; renderQuestions();
    });
    $("f2026").addEventListener("change", function () {
      state.qFilters.is2026 = this.checked; state.qPage.page = 1; renderQuestions();
    });
    var searchTimer = null;
    $("fSearch").addEventListener("input", function () {
      var v = this.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.qFilters.search = v; state.qPage.page = 1; renderQuestions();
      }, 200);
    });
    $("qReset").addEventListener("click", function () {
      state.qFilters = { subject: "", topic: "", institution: "", year: "", stars: "0", type: "", is2026: false, search: "" };
      state.qPage.page = 1;
      ["fSubject", "fTopic", "fInst", "fYear", "fType", "fSearch"].forEach(function (id) { if ($(id)) $(id).value = ""; });
      $("fStars").value = "0"; $("f2026").checked = false;
      populateTopics("");
      renderQuestions();
    });

    // IMP filter bar
    var ifb = $("impFilters");
    ifb.innerHTML =
      '<div class="field toggle-field"><label><input type="checkbox" id="imp2026"> 2026 exam only</label></div>' +
      '<div class="field search"><label for="impSearch">Search question / topic</label>' +
      '<input type="text" id="impSearch" placeholder="Search within IMP questions\u2026"></div>';
    $("imp2026").addEventListener("change", function () {
      state.impFilters.is2026 = this.checked; state.impPage.page = 1; renderImp();
    });
    var impTimer = null;
    $("impSearch").addEventListener("input", function () {
      var v = this.value; clearTimeout(impTimer);
      impTimer = setTimeout(function () { state.impFilters.search = v; state.impPage.page = 1; renderImp(); }, 200);
    });
  }

  function populateTopics(subject) {
    var sel = $("fTopic");
    if (!sel) return;
    var topics;
    if (subject) topics = unique(state.questions.filter(function (q) { return q.subject === subject; }).map(function (q) { return q.topic; }));
    else topics = unique(state.questions.map(function (q) { return q.topic; }));
    sel.innerHTML = '<option value="">All</option>' + topics.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + "</option>";
    }).join("");
  }

  /* ----------------------------- Filtering ----------------------------- */
  function filterQuestions(f) {
    var s = (f.search || "").toLowerCase().trim();
    var starsMin = parseInt(f.stars || "0", 10);
    return state.questions.filter(function (q) {
      if (f.subject && q.subject !== f.subject) return false;
      if (f.topic && q.topic !== f.topic) return false;
      if (f.institution && q.sources.indexOf(f.institution) === -1) return false;
      if (f.year && q.years.indexOf(f.year) === -1) return false;
      if (starsMin && q.stars < starsMin) return false;
      if (f.type && q.type !== f.type) return false;
      if (f.is2026 && !q.is2026) return false;
      if (s) {
        if (q.question.toLowerCase().indexOf(s) === -1 && q.topic.toLowerCase().indexOf(s) === -1) return false;
      }
      return true;
    });
  }

  /* ----------------------------- Card rendering ------------------------ */
  function cardHTML(q) {
    var done = isDone(q);
    var imp = q.stars >= 2;
    var meta = [];
    if (q.type) meta.push('<span class="badge type-' + esc(q.type) + '">' + esc(q.type) + "</span>");
    if (q.stars) meta.push('<span class="stars" title="Importance">' + starsStr(q.stars) + "</span>");
    if (q.is2026) meta.push('<span class="badge flag2026">2026</span>');
    if (q.repeats > 1) meta.push('<span class="badge">Repeats: ' + q.repeats + "</span>");
    var years = q.years.join(", ");
    if (years) meta.push('<span>' + esc(years) + "</span>");
    var hasNote = !!(getNote(q.id) || getImg(q.id));
    return '<div class="qcard ' + (done ? "done " : "") + (imp ? "imp" : "") + '" data-id="' + esc(q.id) + '">' +
      '<div class="qcard__meta">' + meta.join("") + "</div>" +
      '<div class="qcard__topic">' + esc(q.topic || "(untitled)") + "</div>" +
      '<div class="qcard__question">' + esc(q.question) + "</div>" +
      '<div class="qcard__foot">' +
        '<div class="qcard__sources">' + esc(q.subject) + (q.sources.length ? " &middot; " + esc(q.sources.join(", ")) : "") + "</div>" +
        '<div class="qcard__actions">' +
          '<label class="done-check"><input type="checkbox" class="qdone" ' + (done ? "checked" : "") + "> Done</label>" +
          '<button class="btn small notes-btn"' + (hasNote ? ' title="Has notes"' : "") + ">Notes" + (hasNote ? ' <span class="notes-dot">\u25CF</span>' : "") + "</button>" +
        "</div>" +
      "</div>" +
      '<div class="qcard__notes" hidden></div>' +
    "</div>";
  }

  function renderPaged(gridId, pagId, countId, list, pageState, prefix) {
    var grid = $(gridId);
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (pageState.page > pages) pageState.page = pages;
    if (pageState.page < 1) pageState.page = 1;
    var start = (pageState.page - 1) * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);

    grid.innerHTML = slice.length ? slice.map(cardHTML).join("") :
      '<div class="empty-state">No questions match these filters.</div>';
    $(countId).textContent = total.toLocaleString() + " question" + (total === 1 ? "" : "s") + " shown";

    // wire done checkboxes
    var boxes = grid.querySelectorAll(".qdone");
    boxes.forEach(function (cb) {
      cb.addEventListener("change", function () {
        var card = cb.closest(".qcard");
        var id = card.getAttribute("data-id");
        setDone(id, this.checked);
        card.classList.toggle("done", this.checked);
        schedulePush();
        renderDashboard();
        renderProgress();
      });
    });
    // wire notes buttons (lazy-build the editor on expand)
    grid.querySelectorAll(".notes-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".qcard");
        var id = card.getAttribute("data-id");
        var ns = card.querySelector(".qcard__notes");
        var q = state.qMap[id];
        if (!q || !ns) return;
        if (ns.hidden) { ns.innerHTML = ""; ns.appendChild(buildNotesEditor(q)); ns.hidden = false; }
        else { ns.hidden = true; ns.innerHTML = ""; }
      });
    });

    // pagination
    var pag = $(pagId);
    pag.innerHTML = "";
    if (pages <= 1) return;
    var mkBtn = function (label, p, disabled, active) {
      var b = el("button", active ? "active" : "", label);
      b.disabled = !!disabled;
      b.addEventListener("click", function () { pageState.page = p; renderPaged(gridId, pagId, countId, list, pageState, prefix); window.scrollTo(0, 0); });
      return b;
    };
    pag.appendChild(mkBtn("\u00AB", 1, pageState.page === 1));
    pag.appendChild(mkBtn("\u2039", pageState.page - 1, pageState.page === 1));
    var win = 2, from = Math.max(1, pageState.page - win), to = Math.min(pages, pageState.page + win);
    if (from > 1) pag.appendChild(mkBtn("1", 1, false, pageState.page === 1));
    if (from > 2) pag.appendChild(el("span", "", "\u2026"));
    for (var p = from; p <= to; p++) pag.appendChild(mkBtn(String(p), p, false, p === pageState.page));
    if (to < pages - 1) pag.appendChild(el("span", "", "\u2026"));
    if (to < pages) pag.appendChild(mkBtn(String(pages), pages, false, pageState.page === pages));
    pag.appendChild(mkBtn("\u203A", pageState.page + 1, pageState.page === pages));
    pag.appendChild(mkBtn("\u00BB", pages, pageState.page === pages));
  }

  function renderQuestions() {
    var list = filterQuestions(state.qFilters);
    renderPaged("qCardGrid", "qPagination", "qResultCount", list, state.qPage, "q");
  }

  function renderImp() {
    var base = state.questions.filter(function (q) { return q.stars >= 2; });
    var f = state.impFilters;
    var s = (f.search || "").toLowerCase().trim();
    var list = base.filter(function (q) {
      if (f.is2026 && !q.is2026) return false;
      if (s && q.question.toLowerCase().indexOf(s) === -1 && q.topic.toLowerCase().indexOf(s) === -1) return false;
      return true;
    });
    renderPaged("impCardGrid", "impPagination", "impResultCount", list, state.impPage, "imp");
  }

  /* ----------------------------- Progress tab -------------------------- */
  function renderProgress() {
    var acc = $("progressAccordion");
    acc.innerHTML = "";
    var qs = state.questions;
    var subjects = unique(qs.map(function (q) { return q.subject; }));
    subjects.forEach(function (subj) {
      var subset = qs.filter(function (q) { return q.subject === subj; });
      var d = subset.filter(isDone).length;
      var p = subset.length ? Math.round((d / subset.length) * 100) : 0;
      // group by topic
      var topicMap = {};
      subset.forEach(function (q) {
        var t = q.topic || "(untitled)";
        if (!topicMap[t]) topicMap[t] = [];
        topicMap[t].push(q);
      });
      var topics = Object.keys(topicMap).sort();

      var item = el("div", "acc-item" + (state.openSubjects[subj] ? " open" : ""));
      var head = el("div", "acc-head");
      head.innerHTML = '<span>' + esc(subj) + ' <span class="acc-summary">(' + d + "/" + subset.length + " &middot; " + p + "%)</span></span>" +
        '<span class="acc-chev">\u25B6</span>';
      head.addEventListener("click", function () {
        var isOpen = !item.classList.contains("open");
        item.classList.toggle("open", isOpen);
        state.openSubjects[subj] = isOpen;
      });
      item.appendChild(head);

      var body = el("div", "acc-body");
      topics.forEach(function (t) {
        var tqs = topicMap[t];
        var td = tqs.filter(isDone).length;
        var tp = tqs.length ? Math.round((td / tqs.length) * 100) : 0;
        var allDone = td === tqs.length && tqs.length > 0;
        var row = el("div", "topic-row");
        row.innerHTML =
          '<input type="checkbox" class="topic-check" ' + (allDone ? "checked" : "") + ">" +
          '<span class="t-name">' + esc(t) + ' <span class="t-count">' + td + "/" + tqs.length + " &middot; " + tp + '%</span></span>' +
          '<div class="progress-bar"><span style="width:' + tp + '%"></span></div>';
        var cb = row.querySelector(".topic-check");
        cb.addEventListener("change", function () {
          var set = this.checked;
          tqs.forEach(function (q) { setDone(q.id, set); });
          schedulePush();
          renderProgress();
          renderDashboard();
          // refresh visible question cards if on those tabs
          if (state.tab === "questions") renderQuestions();
          if (state.tab === "imp") renderImp();
        });
        body.appendChild(row);
      });
      item.appendChild(body);
      acc.appendChild(item);
    });
  }

  /* ----------------------------- Charts -------------------------------- */
  function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  }
  function chartFontColor() {
    return getComputedStyle(document.body).getPropertyValue("--color-ink-light").trim() || "#5a5a5a";
  }
  function chartGridColor() {
    return getComputedStyle(document.body).getPropertyValue("--color-rule-light").trim() || "#c4c0b6";
  }
  function chartOpts(extra) {
    var base = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: chartFontColor(), font: { family: "Source Sans 3" } } },
        tooltip: { titleFont: { family: "Source Sans 3" }, bodyFont: { family: "Source Sans 3" } }
      },
      scales: {
        x: { ticks: { color: chartFontColor(), font: { family: "Source Sans 3", size: 11 } }, grid: { color: chartGridColor() } },
        y: { ticks: { color: chartFontColor(), font: { family: "Source Sans 3", size: 11 } }, grid: { color: chartGridColor() } }
      }
    };
    return Object.assign(base, extra || {});
  }

  function countBy(arr, keyFn) {
    var m = {};
    arr.forEach(function (x) { var k = keyFn(x); m[k] = (m[k] || 0) + 1; });
    return m;
  }

  function renderProbabilityCharts() {
    var qs = state.questions;
    var font = chartFontColor();

    // 1. Top topics (horizontal bar, top 15)
    destroyChart("chartTopTopics");
    var topicCounts = countBy(qs, function (q) { return q.topic || "(untitled)"; });
    var topicArr = Object.keys(topicCounts).map(function (k) { return [k, topicCounts[k]]; });
    topicArr.sort(function (a, b) { return b[1] - a[1]; });
    var top = topicArr.slice(0, 15).reverse();
    state.charts.chartTopTopics = new Chart($("chartTopTopics"), {
      type: "bar",
      data: { labels: top.map(function (t) { return t[0]; }), datasets: [{ label: "Questions", data: top.map(function (t) { return t[1]; }), backgroundColor: PALETTE[0], borderColor: PALETTE[1], borderWidth: 1 }] },
      options: chartOpts({ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: font }, grid: { color: chartGridColor() } }, y: { ticks: { color: font, font: { size: 10 } }, grid: { display: false } } } })
    });

    // 2. Institution pie
    destroyChart("chartInstPie");
    var instCounts = {};
    qs.forEach(function (q) { q.sources.forEach(function (s) { instCounts[s] = (instCounts[s] || 0) + 1; }); });
    var instKeys = Object.keys(instCounts).sort(function (a, b) { return instCounts[b] - instCounts[a]; });
    state.charts.chartInstPie = new Chart($("chartInstPie"), {
      type: "pie",
      data: { labels: instKeys, datasets: [{ data: instKeys.map(function (k) { return instCounts[k]; }), backgroundColor: instKeys.map(function (_, i) { return PALETTE[i % PALETTE.length]; }) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: font, font: { family: "Source Sans 3", size: 11 } } } } }
    });

    // 3. Year bar
    destroyChart("chartYearBar");
    var yearCounts = {};
    qs.forEach(function (q) { q.years.forEach(function (y) { yearCounts[y] = (yearCounts[y] || 0) + 1; }); });
    var yearKeys = Object.keys(yearCounts).sort();
    state.charts.chartYearBar = new Chart($("chartYearBar"), {
      type: "bar",
      data: { labels: yearKeys, datasets: [{ label: "Questions", data: yearKeys.map(function (k) { return yearCounts[k]; }), backgroundColor: PALETTE[1] }] },
      options: chartOpts({ plugins: { legend: { display: false } } })
    });

    // 4. Most-repeated questions (top 12 by repeats)
    destroyChart("chartRepeats");
    var rep = qs.filter(function (q) { return q.repeats > 1; }).slice();
    rep.sort(function (a, b) { return b.repeats - a.repeats; });
    var topRep = rep.slice(0, 12).reverse();
    state.charts.chartRepeats = new Chart($("chartRepeats"), {
      type: "bar",
      data: {
        labels: topRep.map(function (q) { return (q.topic + " #" + q.num); }),
        datasets: [{ label: "Repeats", data: topRep.map(function (q) { return q.repeats; }), backgroundColor: PALETTE[2] }]
      },
      options: chartOpts({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: function (ctx) { return topRep[ctx.dataIndex].question.slice(0, 120); } } } }, scales: { x: { ticks: { color: font }, grid: { color: chartGridColor() } }, y: { ticks: { color: font, font: { size: 10 } }, grid: { display: false } } } })
    });
  }

  function renderAnalyticsCharts() {
    var qs = state.questions;
    var font = chartFontColor();

    // By subject
    destroyChart("chartBySubject");
    var subjCounts = countBy(qs, function (q) { return q.subject; });
    var subjKeys = Object.keys(subjCounts).sort(function (a, b) { return subjCounts[b] - subjCounts[a]; });
    state.charts.chartBySubject = new Chart($("chartBySubject"), {
      type: "bar",
      data: { labels: subjKeys, datasets: [{ label: "Questions", data: subjKeys.map(function (k) { return subjCounts[k]; }), backgroundColor: PALETTE[0] }] },
      options: chartOpts({ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: font }, grid: { color: chartGridColor() } }, y: { ticks: { color: font, font: { size: 11 } }, grid: { display: false } } } })
    });

    // By stars
    destroyChart("chartByStars");
    var starCounts = { 1: 0, 2: 0, 3: 0 };
    qs.forEach(function (q) { if (q.stars >= 1 && q.stars <= 3) starCounts[q.stars]++; });
    state.charts.chartByStars = new Chart($("chartByStars"), {
      type: "bar",
      data: { labels: ["\u2605", "\u2605\u2605", "\u2605\u2605\u2605"], datasets: [{ label: "Questions", data: [starCounts[1], starCounts[2], starCounts[3]], backgroundColor: [PALETTE[3], PALETTE[0], PALETTE[7]] }] },
      options: chartOpts({ plugins: { legend: { display: false } } })
    });

    // By type
    destroyChart("chartByType");
    var typeCounts = countBy(qs, function (q) { return q.type || "Unknown"; });
    var typeKeys = Object.keys(typeCounts).sort(function (a, b) { return typeCounts[b] - typeCounts[a]; });
    state.charts.chartByType = new Chart($("chartByType"), {
      type: "bar",
      data: { labels: typeKeys, datasets: [{ label: "Questions", data: typeKeys.map(function (k) { return typeCounts[k]; }), backgroundColor: PALETTE[1] }] },
      options: chartOpts({ plugins: { legend: { display: false } } })
    });

    // By institution (pie)
    destroyChart("chartByInst");
    var instCounts = {};
    qs.forEach(function (q) { q.sources.forEach(function (s) { instCounts[s] = (instCounts[s] || 0) + 1; }); });
    var instKeys = Object.keys(instCounts).sort(function (a, b) { return instCounts[b] - instCounts[a]; });
    state.charts.chartByInst = new Chart($("chartByInst"), {
      type: "doughnut",
      data: { labels: instKeys, datasets: [{ data: instKeys.map(function (k) { return instCounts[k]; }), backgroundColor: instKeys.map(function (_, i) { return PALETTE[i % PALETTE.length]; }) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: font, font: { family: "Source Sans 3", size: 11 } } } } }
    });
  }

  /* ----------------------------- Notes & diagrams --------------------- */
  // Markdown -> safe HTML (escape first, then apply lightweight formatting)
  function mdToHtml(md) {
    if (!md) return "";
    var lines = esc(md).split(/\r?\n/);
    var html = [], inUl = false, inOl = false;
    function closeLists() { if (inUl) { html.push("</ul>"); inUl = false; } if (inOl) { html.push("</ol>"); inOl = false; } }
    function inline(t) {
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return t;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^###\s+/.test(line)) { closeLists(); html.push("<h5>" + inline(line.replace(/^###\s+/, "")) + "</h5>"); }
      else if (/^##\s+/.test(line)) { closeLists(); html.push("<h4>" + inline(line.replace(/^##\s+/, "")) + "</h4>"); }
      else if (/^#\s+/.test(line)) { closeLists(); html.push("<h4>" + inline(line.replace(/^#\s+/, "")) + "</h4>"); }
      else if (/^-\s+/.test(line)) { if (!inUl) { closeLists(); html.push("<ul>"); inUl = true; } html.push("<li>" + inline(line.replace(/^-\s+/, "")) + "</li>"); }
      else if (/^\d+\.\s+/.test(line)) { if (!inOl) { closeLists(); html.push("<ol>"); inOl = true; } html.push("<li>" + inline(line.replace(/^\d+\.\s+/, "")) + "</li>"); }
      else if (line.trim() === "") { closeLists(); }
      else { closeLists(); html.push("<p>" + inline(line) + "</p>"); }
    }
    closeLists();
    return html.join("");
  }

  // Image files live in the repo as notes/<slug>.<ext>; slug is filename-safe and unique per id.
  function imgName(id, ext) {
    return id.replace(/\|/g, "-").replace(/[^A-Za-z0-9_-]/g, "_") + "." + ext;
  }
  function mimeToExt(m) {
    if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
    if (m === "image/gif") return "gif";
    if (m === "image/webp") return "webp";
    return "png";
  }
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    var mime = (parts[0].match(/data:(.*?);/) || [, "image/png"])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function getImgSrc(id) {
    try { var local = localStorage.getItem("qbank_img_" + id); if (local) return local; } catch (e) {}
    var img = getImg(id);
    if (img && ghConfigured()) {
      var name = imgName(id, img.type);
      if (usingProxy()) return state.settings.proxyUrl + "/img/" + name + "?v=" + (img.updated || 0);
      return "https://raw.githubusercontent.com/" + encodeURIComponent(state.settings.owner) + "/" +
        encodeURIComponent(state.settings.repo) + "/" + encodeURIComponent(state.settings.branch) +
        "/notes/" + name + "?v=" + (img.updated || 0);
    }
    return null;
  }
  function thumbHtml(id) {
    var src = getImgSrc(id);
    return src
      ? '<img class="notes-thumb-img" src="' + src + '" alt="diagram"/><button class="img-del" title="Remove image">&times;</button>'
      : '<span class="img-empty">No diagram yet</span>';
  }
  function fillThumb(box, id) {
    box.innerHTML = thumbHtml(id);
    var del = box.querySelector(".img-del");
    if (del) del.addEventListener("click", function () { deleteImage(id); fillThumb(box, id); });
  }
  function updateImgThumbs(id) {
    var boxes = document.querySelectorAll('.notes-img-thumb[data-id="' + id + '"]');
    Array.prototype.forEach.call(boxes, function (box) { fillThumb(box, id); });
  }
  function saveImage(id, dataUrl) {
    var mime = (dataUrl.match(/data:(.*?);/) || [, "image/png"])[1];
    var ext = mimeToExt(mime);
    try { localStorage.setItem("qbank_img_" + id, dataUrl); }
    catch (e) { toast("Image too large to store locally.", "err"); return; }
    setImg(id, { type: ext, updated: Date.now() });
    saveProgressLocal();
    schedulePush();
    updateImgThumbs(id);
    if (!ghConfigured()) { toast("Saved locally. Configure sync to back up diagrams.", "ok"); return; }
    var name = imgName(id, ext);
    if (usingProxy()) {
      fetch(state.settings.proxyUrl + "/img/" + name, { method: "PUT", headers: { "Content-Type": mime }, body: dataUrlToBlob(dataUrl) })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (!res.ok) toast("Diagram sync failed: " + (res.error || ""), "err"); })
        .catch(function () { toast("Diagram sync failed (network).", "err"); });
    } else {
      var b64 = dataUrl.split(",")[1];
      fetch(GH_API + "/repos/" + encodeURIComponent(state.settings.owner) + "/" + encodeURIComponent(state.settings.repo) +
        "/contents/notes/" + name + "?ref=" + encodeURIComponent(state.settings.branch), { headers: ghHeaders() })
        .then(function (r) { if (r.ok) return r.json().then(function (d) { return d.sha; }); return null; })
        .then(function (sha) {
          var body = { message: "Add diagram " + name, content: b64, branch: state.settings.branch };
          if (sha) body.sha = sha;
          return fetch(GH_API + "/repos/" + encodeURIComponent(state.settings.owner) + "/" + encodeURIComponent(state.settings.repo) +
            "/contents/notes/" + name, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()), body: JSON.stringify(body) });
        })
        .then(function (r) { if (!r.ok && r.status !== 200 && r.status !== 201) toast("Diagram sync failed (HTTP " + r.status + ").", "err"); })
        .catch(function () { toast("Diagram sync failed (network).", "err"); });
    }
  }
  function deleteImage(id) {
    try { localStorage.removeItem("qbank_img_" + id); } catch (e) {}
    setImg(id, null);
    var p = state.progress[id];
    if (p && !p.done && !p.note) delete state.progress[id];
    saveProgressLocal();
    schedulePush();
    updateImgThumbs(id);
  }

  // Simple drawing dialog -> PNG -> saveImage
  function openDrawDialog(id) {
    var overlay = el("div", "draw-overlay");
    overlay.innerHTML =
      '<div class="draw-dialog">' +
        '<h3>Draw diagram</h3>' +
        '<canvas class="draw-canvas" width="640" height="360"></canvas>' +
        '<div class="draw-tools">' +
          '<button class="dcolor active" data-c="#111111" style="background:#111"></button>' +
          '<button class="dcolor" data-c="#c0392b" style="background:#c0392b"></button>' +
          '<button class="dcolor" data-c="#2980b9" style="background:#2980b9"></button>' +
          '<button class="dcolor" data-c="#27ae60" style="background:#27ae60"></button>' +
          '<label class="dsize">Size <input type="range" min="1" max="24" value="3"></label>' +
          '<button class="btn small" data-act="eraser">Eraser</button>' +
          '<button class="btn small" data-act="clear">Clear</button>' +
        '</div>' +
        '<div class="draw-foot">' +
          '<button class="btn" data-act="cancel">Cancel</button>' +
          '<button class="btn accent" data-act="save">Save to notes</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var canvas = overlay.querySelector("canvas");
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    var drawing = false, color = "#111111", size = 3, eraser = false, last = null;
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) { if (!drawing) return; e.preventDefault(); var p = pos(e); ctx.strokeStyle = eraser ? "#ffffff" : color; ctx.lineWidth = eraser ? size * 3 : size; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; }
    function end() { drawing = false; }
    canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start); canvas.addEventListener("touchmove", move); canvas.addEventListener("touchend", end);
    overlay.querySelectorAll(".dcolor").forEach(function (b) {
      b.addEventListener("click", function () {
        eraser = false; color = b.getAttribute("data-c");
        overlay.querySelector('[data-act="eraser"]').classList.remove("active");
        overlay.querySelectorAll(".dcolor").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
    });
    overlay.querySelector(".dsize input").addEventListener("input", function () { size = parseInt(this.value, 10); });
    overlay.querySelector('[data-act="eraser"]').addEventListener("click", function () { eraser = !eraser; this.classList.toggle("active", eraser); });
    overlay.querySelector('[data-act="clear"]').addEventListener("click", function () { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); });
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", function () { document.body.removeChild(overlay); });
    overlay.querySelector('[data-act="save"]').addEventListener("click", function () {
      saveImage(id, canvas.toDataURL("image/png"));
      updateImgThumbs(id);
      document.body.removeChild(overlay);
      toast("Diagram saved.", "ok");
    });
  }

  // Build a notes editor element (Write/Preview tabs, markdown textarea, image controls)
  function buildNotesEditor(q) {
    var id = q.id;
    var ed = el("div", "notes-editor");
    ed.innerHTML =
      '<div class="notes-tabs">' +
        '<button class="ntab active" data-mode="write">Write</button>' +
        '<button class="ntab" data-mode="preview">Preview</button>' +
      '</div>' +
      '<div class="notes-write">' +
        '<textarea class="notes-ta" placeholder="Write your answer notes... Markdown: **bold**, *italic*, - bullet, 1. numbered, # heading"></textarea>' +
        '<div class="notes-img-row">' +
          '<div class="notes-img-thumb" data-id="' + esc(id) + '"></div>' +
          '<div class="notes-img-btns">' +
            '<button class="btn small" data-act="upload">Upload image</button>' +
            '<button class="btn small" data-act="draw">Draw diagram</button>' +
            '<input type="file" class="notes-file" accept="image/*" hidden>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="notes-preview" hidden></div>' +
      '<div class="notes-foot"><span class="notes-hint">Auto-saved</span>' +
        '<button class="btn small" data-act="collapse">Collapse</button></div>';
    var ta = ed.querySelector(".notes-ta");
    ta.value = getNote(id);
    var saveTimer = null;
    ta.addEventListener("input", function () {
      setNote(id, ta.value);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveProgressLocal(); schedulePush(); }, 800);
    });
    ed.querySelectorAll(".ntab").forEach(function (b) {
      b.addEventListener("click", function () {
        ed.querySelectorAll(".ntab").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        var mode = b.getAttribute("data-mode");
        ed.querySelector(".notes-write").hidden = (mode !== "write");
        var pv = ed.querySelector(".notes-preview");
        pv.hidden = (mode !== "preview");
        if (mode === "preview") {
          var src = getImgSrc(id);
          pv.innerHTML = mdToHtml(getNote(id)) + (src ? '<div class="notes-preview-img"><img src="' + src + '" alt="diagram"/></div>' : "");
        }
      });
    });
    var file = ed.querySelector(".notes-file");
    ed.querySelector('[data-act="upload"]').addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      if (!file.files[0]) return;
      var r = new FileReader();
      r.onload = function () { saveImage(id, r.result); toast("Image added.", "ok"); };
      r.readAsDataURL(file.files[0]);
      file.value = "";
    });
    ed.querySelector('[data-act="draw"]').addEventListener("click", function () { openDrawDialog(id); });
    ta.addEventListener("paste", function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          var blob = items[i].getAsFile();
          var r = new FileReader();
          r.onload = function () { saveImage(id, r.result); toast("Pasted image added.", "ok"); };
          r.readAsDataURL(blob);
          break;
        }
      }
    });
    ed.querySelector('[data-act="collapse"]').addEventListener("click", function () {
      var box = ed.parentNode;
      if (box) { box.hidden = true; box.innerHTML = ""; }
    });
    fillThumb(ed.querySelector(".notes-img-thumb"), id);
    return ed;
  }

  /* ----------------------------- Reader tab --------------------------- */
  function renderReader() {
    var pills = $("readerSubjects"), list = $("readerList"), countEl = $("readerCount");
    if (!pills) return;
    var subjects = unique(state.questions.map(function (q) { return q.subject; }));
    if (!state.readerSubject && subjects.length) state.readerSubject = subjects[0];
    pills.innerHTML = subjects.map(function (s) {
      return '<button class="pill' + (s === state.readerSubject ? " active" : "") + '" data-sub="' + esc(s) + '">' + esc(s) + "</button>";
    }).join("");
    pills.querySelectorAll(".pill").forEach(function (b) {
      b.addEventListener("click", function () { state.readerSubject = b.getAttribute("data-sub"); renderReader(); window.scrollTo(0, 0); });
    });
    var qs = state.questions.filter(function (q) { return q.subject === state.readerSubject; });
    countEl.textContent = qs.length + " question" + (qs.length === 1 ? "" : "s");
    var topicMap = {};
    qs.forEach(function (q) { var t = q.topic || "(untitled)"; (topicMap[t] = topicMap[t] || []).push(q); });
    var topics = Object.keys(topicMap).sort();
    var html = "";
    topics.forEach(function (t) {
      html += '<div class="reader-topic"><h3 class="reader-topic-h">' + esc(t) + ' <span class="reader-topic-c">' + topicMap[t].length + "</span></h3>";
      topicMap[t].forEach(function (q) {
        var note = getNote(q.id);
        var src = getImgSrc(q.id);
        var hasNote = !!(note || src);
        html += '<div class="reader-item" data-id="' + esc(q.id) + '">' +
          '<div class="reader-item__meta">' + esc(q.type || "") + (q.stars ? " " + starsStr(q.stars) : "") + (q.is2026 ? ' <span class="badge flag2026">2026</span>' : "") + (q.repeats > 1 ? ' <span class="badge">x' + q.repeats + "</span>" : "") + "</div>" +
          '<div class="reader-item__q">' + esc(q.question) + "</div>" +
          (hasNote ? '<div class="reader-item__notes">' + (note ? mdToHtml(note) : "") + (src ? '<div class="reader-img"><img src="' + src + '" alt="diagram"/></div>' : "") + "</div>" : "") +
          '<button class="btn small reader-edit" data-id="' + esc(q.id) + '">' + (hasNote ? "Edit notes" : "Add notes") + "</button>" +
          '<div class="reader__notes" hidden></div>' +
        "</div>";
      });
      html += "</div>";
    });
    list.innerHTML = html;
    list.querySelectorAll(".reader-edit").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var item = btn.closest(".reader-item");
        var ns = item.querySelector(".reader__notes");
        var q = state.qMap[id];
        if (!q || !ns) return;
        if (ns.hidden) { ns.innerHTML = ""; ns.appendChild(buildNotesEditor(q)); ns.hidden = false; btn.textContent = "Hide notes"; }
        else { ns.hidden = true; ns.innerHTML = ""; btn.textContent = (getNote(id) || getImg(id)) ? "Edit notes" : "Add notes"; }
      });
    });
  }

  function refreshAll() {
    renderDashboard();
    renderQuestions();
    renderReader();
    renderImp();
    renderProgress();
    renderActiveTabCharts();
  }

  /* ----------------------------- Settings UI --------------------------- */
  function fillSettingsForm() {
    var s = state.settings;
    $("ghProxy").value = s.proxyUrl || "";
    $("ghOwner").value = s.owner || "";
    $("ghRepo").value = s.repo || "";
    $("ghBranch").value = s.branch || "progress-data";
    $("ghPath").value = s.path || "user_progress.json";
    $("ghToken").value = s.token || "";
  }
  function readSettingsForm() {
    state.settings.proxyUrl = $("ghProxy").value.trim();
    state.settings.owner = $("ghOwner").value.trim();
    state.settings.repo = $("ghRepo").value.trim();
    state.settings.branch = $("ghBranch").value.trim() || "progress-data";
    state.settings.path = $("ghPath").value.trim() || "user_progress.json";
    state.settings.token = $("ghToken").value.trim();
    saveSettings();
  }

  function backupProgress() {
    var blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url;
    a.download = "user_progress_backup_" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Backup downloaded.", "ok");
  }
  function restoreProgress(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        if (typeof obj !== "object" || obj === null) throw new Error("Invalid format");
        state.progress = obj;
        saveProgressLocal();
        refreshAll();
        schedulePush();
        toast("Progress restored from file.", "ok");
      } catch (e) { toast("Restore failed: " + e.message, "err"); }
    };
    reader.readAsText(file);
  }

  /* ----------------------------- Init ---------------------------------- */
  function init() {
    // theme
    var theme = localStorage.getItem(LS_THEME) || "light";
    applyTheme(theme);

    // nav
    var navs = document.querySelectorAll("nav.masthead__nav a");
    navs.forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        showTab(a.getAttribute("data-tab"));
      });
    });
    $("navToggle").addEventListener("click", function () {
      var mn = $("mastheadNav");
      var open = mn.classList.toggle("open");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("themeToggle").addEventListener("click", toggleTheme);

    // settings
    loadSettings();
    loadProgressLocal();
    fillSettingsForm();
    setSync(ghConfigured() ? "synced" : "offline");

    $("btnSaveSettings").addEventListener("click", function () {
      readSettingsForm();
      setSync(ghConfigured() ? "synced" : "offline");
      toast("Settings saved.", "ok");
      if (ghConfigured()) pullFromGitHub(true);
    });
    $("btnTestConn").addEventListener("click", function () {
      readSettingsForm();
      if (!ghConfigured()) { toast("Enter a proxy URL, or owner + repo + token.", "err"); return; }
      setSync("pending");
      if (usingProxy()) {
        // Proxy mode: a successful GET read confirms the Worker + token are wired up.
        fetch(state.settings.proxyUrl, { headers: { "Accept": "application/json" } })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.error || "Proxy error");
            toast("Proxy connected. Remote progress entries: " + Object.keys(res.progress || {}).length, "ok");
            setSync("synced");
          })
          .catch(function (err) { setSync("error"); toast("Connection failed: " + err.message, "err"); });
      } else {
        fetch(GH_API + "/repos/" + encodeURIComponent(state.settings.owner) + "/" + encodeURIComponent(state.settings.repo), { headers: ghHeaders() })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(function (repo) {
            state.ghDefaultBranch = repo.default_branch;
            toast("Connected. Default branch: " + repo.default_branch + ". Repo: " + repo.full_name, "ok");
            setSync("synced");
          })
          .catch(function (err) { setSync("error"); toast("Connection failed: " + err.message, "err"); });
      }
    });
    $("btnPull").addEventListener("click", function () { pullFromGitHub(false); });
    $("btnPush").addEventListener("click", function () {
      if (state.pushTimer) { clearTimeout(state.pushTimer); state.pushTimer = null; }
      pushToGitHub(false);
    });
    $("btnBackup").addEventListener("click", backupProgress);
    $("btnRestore").addEventListener("click", function () { $("restoreFile").click(); });
    $("restoreFile").addEventListener("change", function () {
      if (this.files && this.files[0]) restoreProgress(this.files[0]);
      this.value = "";
    });
    $("btnTheme2").addEventListener("click", toggleTheme);
    $("btnClearProgress").addEventListener("click", function () {
      if (!confirm("Clear ALL done-state? This cannot be undone (will also sync to GitHub).")) return;
      state.progress = {};
      saveProgressLocal();
      refreshAll();
      schedulePush();
      toast("All progress cleared.", "ok");
    });

    // load data
    loadData();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
