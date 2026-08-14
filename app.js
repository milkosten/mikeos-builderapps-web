// app.js — mikeos-builderapps SPA controller. Vanilla ES modules, no framework.
// Describe an app -> watch the AI pipeline build it live -> see it deployed.
import { auth } from "/assets/auth.js";
import { api, isMock, AuthError, NotFoundError } from "/assets/api.js";

const APP_BASE = "builderapps.osmike.com";
const CFG = window.BUILDERAPPS_CONFIG;
const root = document.getElementById("root");

// ---------- app state ----------
const state = {
  view: "entry",      // entry|apps|settings|profile|subscription (the "/" shell) | builder
  projects: [],
  project: null,      // full current project { id,title,status,subdomain,url,pipeline,latest_run }
  generating: false,
  // chat conversation thread: [{ role:"user"|"assistant", text, steps:[...], kind }]
  messages: [],
  // live pipeline buffer during a stream: ordered step objects
  live: null,         // { steps:[{idx,name,status}], url, statusText }
  previewNonce: 0,    // bump to force the preview iframe to reload as deploys land
  booting: true,
  hydrating: false,   // loading /builder/<id> from the server
  entryDraft: "",     // the entry-screen textarea text (preserved across renders)
  profile: null,      // userinfo from account.osmike.com (best-effort)
  settings: loadSettings(),

  // ----- builder workspace tabs (right panel) -----
  tab: "site",        // active tab id
  openTabs: [],       // extra (non-pinned) tab ids the user opened, per project
  tabs: {},           // lazy per-tab cache: { [id]: {loading,error,notReady,data} }
  plusOpen: false,    // the "+" menu is showing
  // per-tab view state
  docSel: null,       // selected Goals doc name
  docBody: null,      // { name, loading, error, markdown }
  codePath: "",       // current directory in the Code tree
  codeFile: null,     // { path, loading, error, content, truncated }
  secretsRevealed: false,
  logsAuto: false,
  danger: { busy: false, confirm: "" },

  // Executed pipeline steps rebuilt FROM THE SERVER (latest_run.steps) on load.
  // Kept out of state.messages so it never pollutes the persisted thread.
  runHistory: null,   // { kind, request, status, steps:[{label,pending,failed}] }
};

// A prompt the user submitted while logged out is stashed here (and in sessionStorage)
// so we can resume the build after the OAuth round-trip without losing it.
const PENDING_KEY = "builderapps_pending_prompt";

// ---------- settings (localStorage-persisted) ----------
const SETTINGS_KEY = "builderapps_settings";
function loadSettings() {
  try { return { theme: "dark", reduceMotion: false, autoReload: true,
                 ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) }; }
  catch { return { theme: "dark", reduceMotion: false, autoReload: true }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
  applyTheme();
}
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.settings.theme || "dark");
}

// ---------- routing (real pushState paths) ----------
const PATH_VIEW = { "/": "entry", "/apps": "apps", "/settings": "settings",
                    "/profile": "profile", "/subscription": "subscription", "/builder": "builder" };
const VIEW_PATH = { entry: "/", apps: "/apps", settings: "/settings",
                    profile: "/profile", subscription: "/subscription", builder: "/builder" };
// The "/" family (shell with the left rail). "builder" is the standalone workspace.
const SHELL_VIEWS = new Set(["entry", "apps", "settings", "profile", "subscription"]);

// The builder path CARRIES THE PROJECT ID — "/builder/<id>" — so a reload (or a
// shared link) can rebuild the whole workspace from the server. Bare "/builder"
// stays valid and renders the empty state.
const BUILDER_RE = /^\/builder(?:\/([A-Za-z0-9._-]{1,64}))?\/?$/;

function pathFor(view, id) {
  if (view === "builder") return id ? "/builder/" + encodeURIComponent(id) : "/builder";
  return VIEW_PATH[view] || "/";
}

function navigate(view, { replace = false, id = undefined } = {}) {
  state.view = view;
  const pid = id !== undefined ? id : (view === "builder" && state.project ? state.project.id : null);
  const path = pathFor(view, pid);
  const fn = replace ? "replaceState" : "pushState";
  if (location.pathname !== path) history[fn](null, "", path);
  render();
}
function goBuilder(replace, id) { navigate("builder", { replace: !!replace, id }); }
function goEntry(replace)   { navigate("entry",   { replace: !!replace, id: null }); }

// Once a create stream hands us the real id, rewrite the URL in place so a reload
// lands on /builder/<id> and rehydrates instead of showing an empty builder.
function stampBuilderUrl(id) {
  if (!id) return;
  const path = pathFor("builder", id);
  if (location.pathname !== path) history.replaceState(null, "", path);
}

// Sync the view to the current URL (back/forward, refresh, deep link).
// Returns the project id when the URL is /builder/<id>, else null.
function syncViewFromPath() {
  const m = BUILDER_RE.exec(location.pathname);
  if (m) { state.view = "builder"; return m[1] ? decodeURIComponent(m[1]) : null; }
  state.view = PATH_VIEW[location.pathname] || "entry";
  return null;
}

window.addEventListener("popstate", () => {
  const id = syncViewFromPath();
  if (state.view === "builder" && id && (!state.project || state.project.id !== id)) {
    render();
    enterProject(id, { navigate: false });
    return;
  }
  if (state.view === "builder" && !id) resetBuilder();
  render();
});

// mutable ref to the assistant message currently being narrated by the SSE stream
let liveMsg = null;

function pushMessage(role, fields = {}) {
  const m = { role, text: "", steps: [], kind: "", ...fields };
  state.messages.push(m);
  return m;
}

// A compact copy of the thread for persistence: [{role, text}] only. Empty-text
// messages (still-streaming bubbles) are dropped.
function compactMessages() {
  return state.messages
    .map((m) => ({ role: m.role, text: (m.text || "").trim() }))
    .filter((m) => m.text);
}

// The thread's SOURCE OF TRUTH is the server: PUT /api/projects/{id}/messages,
// read back from GET /api/projects/{id} on load. sessionStorage is kept ONLY as an
// offline fallback for when that endpoint is unreachable — never as the authority.
// The API stores `subdomain` as the FULL host ("abc123.builderapps.osmike.com"), so the old
// `https://${subdomain}.builderapps.osmike.com/` fallback produced a DOUBLED domain
// ("abc123.builderapps.osmike.com.builderapps.osmike.com") — which has no certificate and
// fails with ERR_SSL_PROTOCOL_ERROR, making a healthy app look dead. Build it in one place.
function appUrl(p) {
  if (!p) return "";
  if (p.url) return p.url;
  const host = String(p.subdomain || "").trim();
  if (host.includes(".")) return `https://${host}/`;      // already a full host
  return `https://${host || p.id}.${APP_BASE}/`;
}

function threadKey(id) { return "builderapps_thread_" + id; }

let msgSaveTimer = null;
function persistMessages() {
  if (!state.project) return;
  const id = state.project.id;
  const payload = compactMessages();
  try { sessionStorage.setItem(threadKey(id), JSON.stringify(payload)); } catch {}
  // Debounced, best-effort server write. It must NEVER disrupt the UX: a 404
  // (endpoint not shipped yet) or any other failure is swallowed silently.
  clearTimeout(msgSaveTimer);
  msgSaveTimer = setTimeout(() => {
    if (!api.putMessages) return;
    Promise.resolve(api.putMessages(id, payload)).catch(() => {});
  }, 600);
}
function loadThread(id) {
  try { const raw = sessionStorage.getItem(threadKey(id)); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

// ---------- helpers ----------
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastHost;
function toast(msg, kind = "") {
  if (!toastHost) { toastHost = el("div", { class: "toasts" }); document.body.appendChild(toastHost); }
  const t = el("div", { class: "toast " + kind }, msg);
  toastHost.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 3600);
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  // A FUTURE timestamp (e.g. a certificate expiry) is not "just now" — the
  // relative form only makes sense looking backwards.
  if (diff < 0) return d.toLocaleDateString();
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString();
}

async function guard(fn, { authRetry = true } = {}) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AuthError && authRetry && !isMock()) {
      toast("Session expired — signing you back in…");
      auth.clear();
      setTimeout(() => auth.login(), 600);
      return;
    }
    toast(e.message || "Something went wrong", "err");
    throw e;
  }
}

// A very small inline-markdown renderer (**bold** + `code`) -> escaped, safe HTML.
function mdInline(s) {
  let out = esc(s == null ? "" : s);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

// ---------- a small, SAFE Markdown renderer (self-contained, no libraries) ----------
// Everything is HTML-escaped FIRST, so no document content can inject markup; only
// the tags this function emits itself ever reach the DOM. Links are restricted to
// http(s)/mailto/relative — a `javascript:` href can never be produced.
function safeHref(raw) {
  const u = String(raw || "").trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;   // any other scheme -> drop
  return u || null;                                   // relative link (doc-to-doc)
}

// Inline spans: `code`, **bold**, *italic*, [text](href). Code spans are extracted
// first and re-inserted last so their contents are never re-processed.
function mdSpans(src) {
  const codes = [];
  let s = String(src == null ? "" : src);
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return "\u0000C" + (codes.length - 1) + "\u0000"; });
  s = esc(s);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, text, href) => {
    const h = safeHref(href.replace(/&amp;/g, "&"));
    if (!h) return text;
    return `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => "<code>" + esc(codes[Number(i)]) + "</code>");
  return s;
}

// Block level: headings, fenced code, lists (ordered/unordered), blockquotes,
// horizontal rules, pipe tables, paragraphs.
function mdToHtml(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [], list = null, quote = [], fence = null, fenceLang = "";

  const flushPara = () => {
    if (!para.length) return;
    out.push("<p>" + para.map(mdSpans).join("<br>") + "</p>");
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>` + list.items.map((i) => "<li>" + mdSpans(i) + "</li>").join("") + `</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push("<blockquote>" + quote.map(mdSpans).join("<br>") + "</blockquote>");
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // fenced code
    const f = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(raw);
    if (f) {
      if (fence) {
        out.push(`<pre class="md-pre"${fenceLang ? ` data-lang="${esc(fenceLang)}"` : ""}><code>` +
                 esc(fence.join("\n")) + "</code></pre>");
        fence = null; fenceLang = "";
      } else { flushAll(); fence = []; fenceLang = f[2] || ""; }
      continue;
    }
    if (fence) { fence.push(raw); continue; }

    if (!raw.trim()) { flushAll(); continue; }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) { flushAll(); out.push("<hr>"); continue; }

    // heading
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) { flushAll(); const lvl = h[1].length; out.push(`<h${lvl}>` + mdSpans(h[2]) + `</h${lvl}>`); continue; }

    // blockquote
    const q = /^\s{0,3}>\s?(.*)$/.exec(raw);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    flushQuote();

    // pipe table (header | --- | rows)
    if (/^\s*\|.*\|\s*$/.test(raw) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      flushAll();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(raw);
      let body = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      i--;
      out.push('<div class="md-tablewrap"><table class="md-table"><thead><tr>' +
        head.map((c) => "<th>" + mdSpans(c) + "</th>").join("") + "</tr></thead><tbody>" +
        body.map((r) => "<tr>" + r.map((c) => "<td>" + mdSpans(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>");
      continue;
    }

    // list items
    const ul = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      flushPara();
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    // a continuation line inside a list item
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + raw.trim(); continue; }
    flushList();

    para.push(raw.trim());
  }
  if (fence) out.push('<pre class="md-pre"><code>' + esc(fence.join("\n")) + "</code></pre>");
  flushAll();
  return out.join("\n");
}

// ---------- SSE event -> narration helpers ----------
// Coerce ANY event field into a safe display string. Objects are compacted to their
// most meaningful field (message/stage/name/detail) — NEVER stringified to "[object Object]".
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    return v.message || v.stage || v.name || v.detail || v.text || v.title || "";
  }
  return String(v);
}

// Repaint just the live assistant bubble in place (cheap; avoids a full render()).
function refreshLiveMsg() {
  if (!liveMsg) return;
  const idx = state.messages.indexOf(liveMsg);
  const thread = document.getElementById("chat-thread");
  if (idx < 0 || !thread) return;
  const node = thread.children[idx];
  if (node) { node.replaceWith(chatBubble(liveMsg)); scrollThread(); }
}

// Add / update a status line on the live bubble, DEDUPING consecutive identical lines
// (a repeated progress/stage must not spam the thread). Each line has a done/active state.
function addStatusLine(label, { done = false } = {}) {
  label = textOf(label).trim();
  if (!liveMsg || !label) return;
  const steps = liveMsg.steps;
  // mark all prior lines done, then either update the last if it's a dup or append.
  const last = steps[steps.length - 1];
  if (last && last.label === label) { last.pending = !done; refreshLiveMsg(); return; }
  for (const s of steps) s.pending = false;
  steps.push({ label, pending: !done });
  refreshLiveMsg();
}
// Mark the last status line as complete (done) without adding a new one.
function completeLastLine() {
  if (!liveMsg || !liveMsg.steps.length) return;
  liveMsg.steps[liveMsg.steps.length - 1].pending = false;
  refreshLiveMsg();
}

// ---------- rendering ----------
function render() {
  root.innerHTML = "";
  if (state.booting) { root.appendChild(bootScreen()); return; }
  if (!isMock() && !auth.isAuthed()) { root.appendChild(loginScreen()); return; }
  // The "/" family renders the app-shell (persistent left rail + a main view).
  if (SHELL_VIEWS.has(state.view)) { root.appendChild(shell()); return; }
  // "/builder" is the standalone builder workspace.
  root.appendChild(topbar());
  root.appendChild(el("div", { class: "split" }, leftPanel(), rightPanel()));
  scrollThread();
}

// ---------- app shell: persistent left rail + main area ----------
function shell() {
  return el("div", { class: "shell" }, sideRail(), mainArea());
}

function railItem(view, icon, label) {
  const active = state.view === view;
  return el("button", { class: "rail-item" + (active ? " active" : ""), title: label,
    onclick: () => navigate(view) },
    el("span", { class: "rail-ico", html: icon }),
    el("span", { class: "rail-lbl" }, label));
}

function sideRail() {
  const claims = isMock() ? { name: "Demo user (mock)", email: "demo@osmike.com" } : (auth.user() || {});
  const p = state.profile || {};
  const u = { name: p.name || claims.name, email: p.email || claims.email };
  return el("div", { class: "rail" },
    el("div", { class: "rail-brand", role: "button", title: "Home", onclick: () => goEntry() },
      el("div", { class: "logo" }, "B"),
      el("span", {}, "BuilderApps")),
    el("button", { class: "btn primary rail-new", onclick: () => { newProject(); },
      title: "Start a new app" }, el("span", { html: "&#43;" }), el("span", {}, "Build")),
    el("nav", { class: "rail-nav" },
      railItem("apps", "&#9638;", "Apps"),
      railItem("settings", "&#9881;", "Settings"),
      railItem("profile", "&#128100;", "Profile"),
      railItem("subscription", "&#9733;", "Subscription")),
    el("div", { class: "rail-spacer" }),
    el("div", { class: "rail-account" },
      el("div", { class: "rail-acct-row", title: u.email || "" },
        el("span", { class: "rail-avatar" }, (u.name || u.email || "U").slice(0, 1).toUpperCase()),
        el("div", { class: "rail-acct-meta" },
          el("div", { class: "rail-acct-name" }, u.name || "MikeOS user"),
          u.email ? el("div", { class: "rail-acct-mail" }, u.email) : null)),
      !isMock() && el("button", { class: "btn ghost sm block", onclick: () => auth.logout() }, "Sign out")));
}

function mainArea() {
  switch (state.view) {
    case "apps":         return el("div", { class: "main" }, appsView());
    case "settings":     return el("div", { class: "main" }, settingsView());
    case "profile":      return el("div", { class: "main" }, profileView());
    case "subscription": return el("div", { class: "main" }, subscriptionView());
    default:             return el("div", { class: "main main-entry" }, entryView());
  }
}

// ----- entry (the focused hero + prompt + example chips), inside the shell main area -----
function entryView() {
  const ta = el("textarea", { id: "entry-prompt", class: "entry-input", rows: 3,
    placeholder: "Describe the app you want to build…", autofocus: true });
  ta.value = state.entryDraft || "";
  ta.addEventListener("input", () => { state.entryDraft = ta.value; });

  const submit = () => {
    const v = ta.value.trim();
    if (!v) return;
    state.entryDraft = "";
    startBuild(v);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  const sendBtn = el("button", { class: "btn primary entry-send", title: "Build it", onclick: submit },
    el("span", {}, "Build it"), el("span", { html: "&#8594;", style: "margin-left:2px" }));

  const chips = el("div", { class: "entry-examples" });
  for (const ex of EXAMPLE_PROMPTS) {
    chips.appendChild(el("button", { class: "entry-chip", title: "Use this prompt",
      onclick: () => { ta.value = ex; state.entryDraft = ex; ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length); } }, ex));
  }

  return el("div", { class: "entry-card" },
    el("h1", { class: "entry-hero" }, "What do you want to build today?"),
    el("p", { class: "entry-sub" }, "Describe an app and watch it get built, deployed, and live — a real Node + Postgres + Redis app on its own URL."),
    el("div", { class: "entry-composer" }, ta, el("div", { class: "entry-actions" }, sendBtn)),
    chips);
}

// ----- Apps: the user's real projects from GET /api/projects -----
function appsView() {
  const head = el("div", { class: "view-head" },
    el("h1", {}, "Your apps"),
    el("button", { class: "btn sm", onclick: () => newProject() }, "＋ Build a new app"));
  const list = el("div", { class: "app-list" });
  if (!state.projects.length) {
    list.appendChild(el("div", { class: "empty" }, "No apps yet — build your first one."));
  } else {
    for (const p of state.projects) {
      const url = p.url || appUrl(p);
      list.appendChild(el("div", { class: "app-card", role: "button", title: "Open in the builder",
        onclick: () => openProject(p.id) },
        el("div", { class: "app-card-main" },
          el("div", { class: "app-card-title" }, p.title || p.id),
          el("div", { class: "app-card-sub" },
            el("a", { href: url, target: "_blank", rel: "noopener",
              onclick: (e) => e.stopPropagation() }, url))),
        el("div", { class: "app-card-side" },
          statusPill(p.status),
          el("span", { class: "app-card-when" }, fmtDate(p.updated_at || p.created_at)))));
    }
  }
  return el("div", {}, head, list);
}

// ----- Settings: theme/preferences persisted in localStorage -----
function settingsView() {
  const row = (label, control, hint) => el("div", { class: "set-row" },
    el("div", { class: "set-meta" }, el("div", { class: "set-label" }, label),
      hint ? el("div", { class: "set-hint" }, hint) : null),
    control);

  const themeSel = el("select", { class: "set-select",
    onchange: (e) => { state.settings.theme = e.target.value; saveSettings(); render(); } });
  for (const t of ["dark", "light"]) {
    const o = el("option", { value: t }, t[0].toUpperCase() + t.slice(1));
    if ((state.settings.theme || "dark") === t) o.selected = true;
    themeSel.appendChild(o);
  }

  const rm = toggle(state.settings.reduceMotion, (v) => { state.settings.reduceMotion = v; saveSettings(); });
  const ar = toggle(state.settings.autoReload, (v) => { state.settings.autoReload = v; saveSettings(); });

  return el("div", {},
    el("div", { class: "view-head" }, el("h1", {}, "Settings")),
    el("div", { class: "card-panel" },
      row("Theme", themeSel, "Switch between the dark and light appearance."),
      row("Reduce motion", rm, "Minimise animations across the app."),
      row("Auto-reload preview", ar, "Reload the live preview automatically as deploys land.")),
    el("p", { class: "muted-note" }, "Preferences are saved on this device."));
}

// A small on/off toggle switch.
function toggle(on, onChange) {
  const input = el("input", { type: "checkbox" });
  input.checked = !!on;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "switch" }, input,
    el("span", { class: "track" }, el("span", { class: "knob" })));
}

// ----- Profile: the real signed-in identity (token claims + best-effort userinfo) -----
function profileView() {
  const u = isMock() ? { name: "Demo user (mock)", email: "demo@osmike.com", sub: "mock-sub" } : (auth.user() || {});
  const p = state.profile || {};
  const name = p.name || u.name || "MikeOS user";
  const email = p.email || u.email || "";
  const avatar = p.picture || p.avatar_url || null;
  const sub = p.sub || u.sub || "";

  const av = avatar
    ? el("img", { class: "profile-avatar-img", src: avatar, alt: "", referrerpolicy: "no-referrer" })
    : el("div", { class: "profile-avatar" }, (name || email || "U").slice(0, 1).toUpperCase());

  const field = (label, value) => value ? el("div", { class: "pf-field" },
    el("div", { class: "pf-label" }, label), el("div", { class: "pf-value" }, value)) : null;

  return el("div", {},
    el("div", { class: "view-head" }, el("h1", {}, "Profile")),
    el("div", { class: "card-panel profile-panel" },
      el("div", { class: "profile-top" }, av,
        el("div", {}, el("div", { class: "profile-name" }, name),
          email ? el("div", { class: "profile-mail" }, email) : null)),
      el("div", { class: "pf-fields" },
        field("Name", name),
        field("Email", email),
        field("Account ID", sub),
        field("Identity provider", "account.osmike.com")),
      !isMock() && el("button", { class: "btn sm", onclick: () => auth.logout() }, "Sign out")),
    el("p", { class: "muted-note" }, "Your identity comes from your MikeOS account (read-only here)."));
}

// ----- Subscription: honest placeholder (no billing system exists yet) -----
function subscriptionView() {
  return el("div", {},
    el("div", { class: "view-head" }, el("h1", {}, "Subscription")),
    el("div", { class: "card-panel plan-panel" },
      el("div", { class: "plan-row" },
        el("div", {}, el("div", { class: "plan-name" }, "MikeOS — Free"),
          el("div", { class: "plan-desc" }, "Build, deploy, and host apps on the MikeOS platform.")),
        el("span", { class: "status-pill s-live" }, "Current")),
      el("ul", { class: "plan-feats" },
        el("li", {}, "Full-stack apps (Node + Postgres + Redis), built and deployed for you"),
        el("li", {}, "A live URL per app on builderapps.osmike.com"),
        el("li", {}, "Change requests via the update pipeline"))),
    el("div", { class: "plan-soon" },
      el("strong", {}, "Plans coming soon."),
      el("span", {}, " Everything runs on MikeOS infrastructure — there's no paid tier or checkout yet.")));
}

// Kick off a build from the entry screen: if signed out, run OAuth first (stashing the
// prompt so we resume after the round-trip), else enter the builder and start streaming.
function startBuild(prompt) {
  prompt = (prompt || "").trim();
  if (!prompt) return;
  if (!isMock() && !auth.isAuthed()) {
    try { sessionStorage.setItem(PENDING_KEY, prompt); } catch {}
    auth.login();
    return;
  }
  // A NEW app must start from an EMPTY builder. Without this, starting a build while an
  // existing app was open appended the prompt to THAT app's thread and left its preview,
  // tabs and status pill on screen — the new app looked "mixed up with another application".
  resetBuilder();
  goBuilder();               // real /builder path, pushState
  pushMessage("user", { text: prompt });
  onCreate(prompt);
}

function bootScreen() {
  return el("div", { class: "login" },
    el("div", { class: "card" },
      el("div", { class: "logo-lg" }, "B"),
      el("div", { class: "spin", style: "margin:0 auto" })));
}

function loginScreen() {
  return el("div", { class: "login" },
    el("div", { class: "card" },
      el("div", { class: "logo-lg" }, "B"),
      el("h1", {}, "MikeOS BuilderApps"),
      el("p", {}, "Describe an app. Watch the AI pipeline build it live. See it deployed."),
      el("button", { class: "btn primary block", onclick: () => auth.login() },
        "Login with MikeOS")));
}

// Start a fresh app: clear the current project + thread and return to the entry screen.
function newProject() {
  resetBuilder();
  state.entryDraft = "";
  goEntry();               // back to "/" (the focused landing)
  setTimeout(() => { const ta = document.getElementById("entry-prompt"); if (ta) ta.focus(); }, 30);
}

// Dropdown of the user's apps + a "New app" button.
function projectSwitcher() {
  const sel = el("select", { class: "proj-select", title: "Open one of your apps",
    onchange: (e) => { const id = e.target.value; if (id) openProject(id); } });
  sel.appendChild(el("option", { value: "" },
    state.projects.length ? `Your apps (${state.projects.length})` : "No apps yet"));
  for (const p of state.projects) {
    const when = p.updated_at ? "  ·  " + fmtDate(p.updated_at) : "";
    const opt = el("option", { value: p.id }, (p.title || p.id) + when);
    if (state.project && state.project.id === p.id) opt.selected = true;
    sel.appendChild(opt);
  }
  return el("div", { class: "proj-switcher" },
    sel,
    el("button", { class: "btn sm", title: "Start a new app",
      onclick: () => newProject() }, "＋ New app"));
}

function topbar() {
  const u = isMock() ? { name: "Demo user (mock)" } : auth.user();
  return el("div", { class: "topbar" },
    el("div", { class: "brand", role: "button", title: "Home", style: "cursor:pointer",
      onclick: () => goEntry() },
      el("div", { class: "logo" }, "B"),
      el("span", {}, "MikeOS BuilderApps"),
      isMock() && el("small", {}, "· mock mode")),
    projectSwitcher(),
    el("div", { class: "spacer" }),
    el("div", { class: "who" },
      el("span", { class: "dot" }),
      el("span", {}, u ? u.name : "signed in")),
    !isMock() && el("button", { class: "btn ghost sm", onclick: () => auth.logout() }, "Sign out"));
}

// ----- left panel: the chat conversation -----
function leftPanel() {
  const thread = el("div", { class: "chat-thread", id: "chat-thread" });
  if (state.hydrating) {
    thread.appendChild(el("div", { class: "msg assistant" }, el("div", { class: "avatar" }, "B"),
      el("div", { class: "bubble" }, el("div", { class: "hydrating" },
        el("span", { class: "spin sm" }), el("span", {}, "Loading this app's history…")))));
  } else if (!state.messages.length && !state.runHistory) {
    thread.appendChild(chatIntro());
  } else {
    for (const m of state.messages) thread.appendChild(chatBubble(m));
    // Executed steps replayed from the server go last, below the conversation.
    if (state.runHistory) thread.appendChild(runHistoryBubble(state.runHistory));
  }
  return el("div", { class: "left chat" }, thread, composer());
}

const EXAMPLE_PROMPTS = [
  "A URL shortener with click analytics and a dashboard of my links",
  "A team standup tool: each member posts yesterday/today/blockers, with a daily digest",
  "A personal expense tracker with categories, a monthly chart, and CSV export",
  "A public changelog / release-notes site with an admin editor and RSS feed",
  "A simple job board where companies post roles and candidates apply",
];

function chatIntro() {
  const chips = el("div", { class: "chat-examples" });
  for (const ex of EXAMPLE_PROMPTS) {
    chips.appendChild(el("button", { class: "chat-chip", disabled: state.generating,
      title: "Use this prompt", onclick: () => fillComposer(ex) }, ex));
  }
  return el("div", { class: "msg assistant" },
    el("div", { class: "avatar" }, "B"),
    el("div", { class: "bubble" },
      el("h2", { class: "intro-hero" }, "What do you want to build today?"),
      el("p", {}, "Describe an app and watch it get built, deployed, and live — a real Node + Postgres + Redis app on its own URL. Watch each pipeline step stream in. Some ideas:"),
      chips));
}

function chatBubble(m) {
  if (m.role === "user") {
    return el("div", { class: "msg user" }, el("div", { class: "bubble" }, m.text));
  }
  const bubble = el("div", { class: "bubble" + (m.kind === "error" ? " error" : "") });
  if (m.steps && m.steps.length) bubble.appendChild(stepList(m.steps));
  if (m.text) bubble.appendChild(el("div", { class: "msg-text", html: mdInline(m.text) }));
  return el("div", { class: "msg assistant" }, el("div", { class: "avatar" }, "B"), bubble);
}

// A compact checklist: done lines get a check, failed lines a cross, the active
// (last) line spins. Used identically for LIVE-streamed steps and for executed
// steps replayed from the server (latest_run.steps) — so a reload looks the same.
function stepList(steps) {
  const list = el("div", { class: "chat-steps" });
  steps.forEach((s) => {
    const pending = s.pending !== false;
    const cls = s.failed ? "failed" : pending ? "active" : "done";
    const mark = s.failed ? el("span", { class: "xmk" }, "✗")
               : pending ? el("span", { class: "spin sm" })
               : el("span", { class: "chk" }, "✓");
    list.appendChild(el("div", { class: "chat-step " + cls }, mark,
      el("span", { class: "cs-label", html: mdInline(s.label) })));
  });
  return list;
}

// ----- executed pipeline history, replayed from the SERVER (latest_run.steps) -----
// Rendered as its own bubble at the end of the thread. Deliberately NOT part of
// state.messages so it is never persisted back as chat text.
function runHistoryBubble(run) {
  const kind = run.kind === "update" ? "Update run" : "Build run";
  const bubble = el("div", { class: "bubble run-history" });
  // Built from elements, not markdown — mdInline has no italics, so a template
  // string here would print literal asterisks.
  bubble.appendChild(el("div", { class: "run-head" },
    el("strong", {}, kind),
    run.request ? el("span", { class: "run-req" }, " — " + run.request) : null));
  if (run.steps && run.steps.length) bubble.appendChild(stepList(run.steps));
  else bubble.appendChild(el("div", { class: "empty" }, "No steps recorded for this run yet."));
  if (run.status === "running") {
    bubble.appendChild(el("div", { class: "run-foot" }, "Still running — watching for new steps…"));
  } else if (run.status === "failed") {
    bubble.appendChild(el("div", { class: "run-foot bad" }, "This run failed."));
  }
  return el("div", { class: "msg assistant" }, el("div", { class: "avatar" }, "B"), bubble);
}

// Turn a server run row into the shape stepList() renders. Step names are the
// pipeline's snake_case identifiers; humanise them and append a short log tail.
function humanStepName(name) {
  const s = String(name || "").replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Step";
}
function runToHistory(run) {
  if (!run) return null;
  const steps = (run.steps || []).slice()
    .sort((a, b) => (a.idx || 0) - (b.idx || 0))
    .map((s) => {
      const log = (s.log == null ? "" : String(s.log)).replace(/\s+/g, " ").trim();
      const tail = log ? " · `" + (log.length > 110 ? log.slice(0, 107) + "…" : log) + "`" : "";
      return { label: humanStepName(s.name) + tail,
               pending: s.status === "running",
               failed: s.status === "failed" };
    });
  const derived = steps.some((s) => s.pending) ? "running"
                : steps.some((s) => s.failed) ? "failed" : "done";
  return { kind: run.kind || "create", request: run.request || "",
           status: run.status || derived, steps };
}

// The composer pinned at the bottom of the left.
function composer() {
  const ta = el("textarea", { id: "prompt", class: "chat-input", rows: 1,
    placeholder: state.project ? "Request a change to this app…" : "Describe the app you want…",
    disabled: state.generating });

  const send = () => {
    const v = ta.value.trim();
    if (!v) return;
    ta.value = ""; autoGrow(ta);
    sendMessage(v);
  };
  const sendBtn = el("button", { class: "btn primary chat-send", title: "Send",
    disabled: state.generating, onclick: send },
    state.generating ? el("span", { class: "spin" }) : el("span", { html: "&#8593;" }));

  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  const hint = state.project
    ? el("div", { class: "composer-hint" }, "Changes run the update pipeline on this app.")
    : el("div", { class: "composer-hint" }, "A full build can take a few minutes — steps stream live.");

  return el("div", { class: "composer" }, hint,
    el("div", { class: "composer-row" }, ta, sendBtn));
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}

function scrollThread() {
  const t = document.getElementById("chat-thread");
  if (t) t.scrollTop = t.scrollHeight;
}

// ----- right panel: status pill + live preview iframe -----
function statusPill(status) {
  const s = (status || "unknown").toLowerCase();
  const label = { creating: "Creating", building: "Building", deploying: "Deploying",
                  live: "Live", failed: "Failed", stopped: "Stopped" }[s] || (status || "…");
  return el("span", { class: "status-pill s-" + s }, label);
}

// ---------- the tabbed workspace (right panel) ----------
// Six PINNED tabs are always present; the "+" menu opens any of the extra ones,
// which are closable and remembered per project in localStorage.
const TABS = {
  site:        { label: "Site",         pinned: true,  icon: "▤" },
  goals:       { label: "Goals",        pinned: true,  icon: "◎" },
  code:        { label: "Code",         pinned: true,  icon: "‹›" },
  database:    { label: "Database",     pinned: true,  icon: "▤" },
  secrets:     { label: "Secrets",      pinned: true,  icon: "🔑" },
  logs:        { label: "Logs",         pinned: true,  icon: "≡" },
  usage:       { label: "Usage & Cost" },
  commits:     { label: "Commits" },
  deployments: { label: "Deployments" },
  qa:          { label: "QA & Tests" },
  backlog:     { label: "Backlog" },
  routes:      { label: "API Routes" },
  metrics:     { label: "Metrics" },
  cache:       { label: "Cache" },
  domain:      { label: "Domain & TLS" },
  env:         { label: "Environment" },
  danger:      { label: "Danger Zone" },
};
const PINNED_TABS = Object.keys(TABS).filter((k) => TABS[k].pinned);
const EXTRA_TABS  = Object.keys(TABS).filter((k) => !TABS[k].pinned);

// Which extra tabs a project has open is a per-project UI preference.
function tabsKey(id) { return "builderapps_tabs_" + id; }
function loadOpenTabs(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(tabsKey(id)) || "[]");
    return Array.isArray(raw) ? raw.filter((t) => EXTRA_TABS.includes(t)) : [];
  } catch { return []; }
}
function saveOpenTabs() {
  if (!state.project) return;
  try { localStorage.setItem(tabsKey(state.project.id), JSON.stringify(state.openTabs)); } catch {}
}

// Repaint ONLY the right panel — switching tabs must not rebuild the chat thread
// (which would drop its scroll position) or reload the preview iframe needlessly.
function repaintRight() {
  const old = document.querySelector(".split > .right");
  if (!old) { render(); return; }
  old.replaceWith(rightPanel());
}

// Repaint ONLY the chat side — used by the run poller so a 4s tick never reloads
// the live-preview iframe underneath the user.
// A signature of everything the left panel actually renders. The run poller ticks every
// 4s whether or not anything changed; repainting on every tick made the panel visibly
// "flip" and yanked the reader back to the bottom mid-sentence. Repaint only when this
// changes — i.e. only when there is genuinely something new to show.
function leftSignature() {
  try {
    return JSON.stringify({
      p: state.project && state.project.id,
      s: state.project && state.project.status,
      g: state.generating,
      m: (state.messages || []).map((m) => [m.role, m.text, m.kind,
        (m.steps || []).map((s) => s.name + ":" + s.status + ":" + (s.log || "").length)]),
      r: (state.runHistory || []).map((s) => s.name + ":" + s.status),
    });
  } catch { return String(Math.random()); }   // never suppress a paint on an error
}

let _leftSig = null;
function repaintLeft() {
  const old = document.querySelector(".split > .left");
  if (!old) { render(); return; }
  const sig = leftSignature();
  if (sig === _leftSig) return;               // nothing new — leave the DOM (and the scroll) alone
  _leftSig = sig;

  // Preserve the reader's place: only auto-scroll if they were already at the bottom.
  const sc = old.querySelector(".thread") || old.querySelector(".scroll");
  const wasNearBottom = !sc || (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 80;
  const prevTop = sc ? sc.scrollTop : 0;

  old.replaceWith(leftPanel());

  const next = document.querySelector(".split > .left .thread")
    || document.querySelector(".split > .left .scroll");
  if (next) {
    if (wasNearBottom) scrollThread();
    else next.scrollTop = prevTop;            // reading history? stay put
  }
}

function selectTab(id) {
  state.tab = id;
  state.plusOpen = false;
  repaintRight();
  loadTab(id);
}
function openExtraTab(id) {
  if (!state.openTabs.includes(id)) { state.openTabs.push(id); saveOpenTabs(); }
  selectTab(id);
}
function closeExtraTab(id) {
  state.openTabs = state.openTabs.filter((t) => t !== id);
  saveOpenTabs();
  if (state.tab === id) state.tab = "site";
  repaintRight();
}

function rightPanel() {
  const proj = state.project;
  const status = state.generating && state.live ? (state.live.statusText || "building")
               : (proj && proj.status) || null;
  const tabDef = TABS[state.tab] || TABS.site;

  const head = el("div", { class: "right-head" },
    el("div", { class: "right-title" },
      el("span", {}, proj ? (proj.title || proj.id) : "Live preview"),
      status ? statusPill(status) : null),
    el("div", { class: "spacer" }),
    proj ? urlPill(proj) : null,
    proj ? el("button", { class: "btn sm", title: "Refresh this tab",
      onclick: () => refreshTab() }, "↻ Refresh") : null,
    proj ? el("a", { class: "btn sm", href: proj.url, target: "_blank", rel: "noopener" }, "Open ↗") : null);

  const body = el("div", { class: "right-body" });
  if (!proj) { body.appendChild(placeholder()); return el("div", { class: "right" }, head, body); }

  body.appendChild(el("div", { class: "tab-root" }, tabBody(state.tab)));
  return el("div", { class: "right" }, head, tabBar(), body);
}

function tabBar() {
  const bar = el("div", { class: "wtabs" });
  const mk = (id, closable) => {
    const t = TABS[id];
    const btn = el("button", { class: "wtab" + (state.tab === id ? " active" : ""),
      title: t.label, onclick: () => selectTab(id) }, el("span", {}, t.label));
    if (closable) {
      btn.appendChild(el("span", { class: "wtab-x", title: "Close this tab",
        onclick: (e) => { e.stopPropagation(); closeExtraTab(id); } }, "×"));
    }
    return btn;
  };
  for (const id of PINNED_TABS) bar.appendChild(mk(id, false));
  for (const id of state.openTabs) if (TABS[id]) bar.appendChild(mk(id, true));

  const plus = el("div", { class: "wtab-plus-wrap" },
    el("button", { class: "wtab plus" + (state.plusOpen ? " active" : ""),
      title: "Open another tab",
      onclick: (e) => { e.stopPropagation(); state.plusOpen = !state.plusOpen; repaintRight(); } }, "＋"));
  if (state.plusOpen) {
    const menu = el("div", { class: "wtab-menu" });
    const avail = EXTRA_TABS.filter((t) => !state.openTabs.includes(t));
    if (!avail.length) menu.appendChild(el("div", { class: "wtab-menu-empty" }, "Every tab is already open."));
    for (const id of avail) {
      menu.appendChild(el("button", { class: "wtab-menu-item",
        onclick: () => openExtraTab(id) }, TABS[id].label));
    }
    // The tab bar is a horizontal scroller (overflow-x: auto). Per CSS, once one axis is
    // non-visible the other computes to auto too, so an absolutely-positioned drop-down is
    // CLIPPED by the bar — the menu opened but was invisible. Anchor it to the viewport
    // instead and position it from the button's rect, so nothing can clip it.
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";          // measure before showing, avoids a flash
    requestAnimationFrame(() => {
      const b = plus.querySelector(".wtab.plus");
      if (!b || !menu.isConnected) return;
      const r = b.getBoundingClientRect();
      const w = menu.offsetWidth || 200;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      menu.style.left = left + "px";
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.maxHeight = Math.max(140, window.innerHeight - r.bottom - 24) + "px";
      menu.style.visibility = "visible";
    });
    plus.appendChild(menu);
  }
  bar.appendChild(plus);
  return bar;
}

// Dismiss the "+" menu on any outside click.
document.addEventListener("click", () => {
  if (state.plusOpen) { state.plusOpen = false; repaintRight(); }
});

// ---------- lazy per-tab loading ----------
// Every tab fetches ON FIRST OPEN only. A 404 (endpoint not shipped yet) or an
// empty list renders a calm empty state — never an error, and never blocking the
// chat or the preview.
const TAB_FETCH = {
  goals:       (id) => api.projectDocs(id),
  code:        (id) => api.projectFiles(id, state.codePath || ""),
  database:    (id) => api.projectDatabase(id),
  secrets:     (id) => api.projectSecrets(id, state.secretsRevealed),
  logs:        (id) => api.projectLogs(id, 200),
  usage:       (id) => api.projectUsage(id),
  commits:     (id) => api.projectCommits(id),
  deployments: (id) => api.projectDeployments(id),
  qa:          (id) => api.projectQa(id),
  backlog:     (id) => api.projectBacklog(id),
  routes:      (id) => api.projectRoutes(id),
  metrics:     (id) => api.projectMetrics(id),
  cache:       (id) => api.projectCache(id),
  domain:      (id) => api.projectDomain(id),
  env:         (id) => api.projectEnv(id),
};

async function loadTab(tab, { force = false } = {}) {
  const fetcher = TAB_FETCH[tab];
  if (!fetcher || !state.project) return;
  const cur = state.tabs[tab];
  if (!force && cur && (cur.loading || cur.data || cur.notReady)) return;
  const id = state.project.id;
  state.tabs[tab] = { loading: true };
  if (state.tab === tab) repaintRight();
  let next;
  try {
    next = { data: await fetcher(id) };
  } catch (e) {
    // NotFound == "the backend hasn't shipped this yet" -> empty state, not an error.
    if (e instanceof NotFoundError || (e && e.name === "NotFoundError")) next = { notReady: true };
    else if (e instanceof AuthError) next = { error: "Session expired — reload to sign in again." };
    else next = { error: (e && e.message) || "Could not load this tab." };
  }
  // Ignore a response that arrived after the user switched projects.
  if (!state.project || state.project.id !== id) return;
  state.tabs[tab] = next;
  if (state.tab === tab) repaintRight();
}

function refreshTab() {
  const tab = state.tab;
  if (tab === "site") { state.previewNonce++; repaintRight(); return; }
  if (tab === "goals" && state.docSel) { loadDoc(state.docSel, true); }
  if (tab === "code" && state.codeFile) { loadFile(state.codeFile.path, true); }
  loadTab(tab, { force: true });
}

// ---------- generic, shape-tolerant renderers ----------
// A cell is ALWAYS rendered as readable text. Objects/arrays are JSON-compacted,
// so a surprise shape can never print "[object Object]".
function cellText(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length ? v.map(cellText).join(", ") : "—";
  try { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + "…" : s; }
  catch { return "—"; }
}

const HUMAN_COL = (k) => k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Table over an array of records. `cols` picks/orders columns; any extra keys the
// server sends are appended so nothing is silently lost.
function recordsTable(rows, cols, renderers = {}, omit = []) {
  const keys = [];
  for (const c of cols || []) if (rows.some((r) => c in (r || {}))) keys.push(c);
  for (const r of rows) for (const k of Object.keys(r || {})) {
    if (!keys.includes(k) && !omit.includes(k)) keys.push(k);
  }

  const table = el("table", { class: "dtable" });
  table.appendChild(el("thead", {}, el("tr", {}, keys.map((k) => el("th", {}, HUMAN_COL(k))))));
  const tb = el("tbody", {});
  for (const r of rows) {
    tb.appendChild(el("tr", {}, keys.map((k) => {
      const rend = renderers[k];
      return el("td", {}, rend ? rend(r[k], r) : cellText(r[k]));
    })));
  }
  table.appendChild(tb);
  return el("div", { class: "dtable-wrap" }, table);
}

function tabEmpty(msg) {
  return el("div", { class: "tab-empty" },
    el("div", { class: "te-mark" }, "◍"),
    el("div", { class: "te-text" }, msg || "Not generated yet — the pipeline is still running."));
}
function tabLoading() {
  return el("div", { class: "tab-empty" }, el("span", { class: "spin" }),
    el("div", { class: "te-text" }, "Loading…"));
}
function tabError(msg, onRetry) {
  return el("div", { class: "tab-empty" },
    el("div", { class: "te-mark bad" }, "!"),
    el("div", { class: "te-text" }, msg),
    onRetry ? el("button", { class: "btn sm", onclick: onRetry }, "Try again") : null);
}
function tabPane(...kids) { return el("div", { class: "tab-pane" }, ...kids); }
function tabToolbar(...kids) { return el("div", { class: "tab-toolbar" }, ...kids); }

// Resolve a tab's cached state into either a status view or the caller's renderer.
function withTab(tab, renderData) {
  const t = state.tabs[tab];
  if (!t || t.loading) return tabLoading();
  if (t.notReady) return tabEmpty();
  if (t.error) return tabError(t.error, () => loadTab(tab, { force: true }));
  return renderData(t.data || {});
}

// ---------- individual tab bodies ----------
function tabBody(tab) {
  switch (tab) {
    case "site":        return siteTab();
    case "goals":       return goalsTab();
    case "code":        return codeTab();
    case "database":    return databaseTab();
    case "secrets":     return secretsTab();
    case "logs":        return logsTab();
    case "usage":       return usageTab();
    case "commits":     return commitsTab();
    case "deployments": return deploymentsTab();
    case "qa":          return qaTab();
    case "backlog":     return backlogTab();
    case "routes":      return routesTab();
    case "metrics":     return metricsTab();
    case "cache":       return cacheTab();
    case "domain":      return domainTab();
    case "env":         return envTab();
    case "danger":      return dangerTab();
    default:            return siteTab();
  }
}

function siteTab() { return previewIframe(state.project); }

// ----- Goals: the pipeline's strategy docs, rendered as Markdown -----
function goalsTab() {
  return withTab("goals", (data) => {
    const docs = (data.docs || []).slice();
    if (!docs.length) return tabEmpty("No strategy docs yet — the pipeline writes VISION, ICP, UX and the technical plan as it builds.");
    if (!state.docSel || !docs.some((d) => d.name === state.docSel)) {
      state.docSel = docs[0].name;
      // defer: never start a fetch (and a repaint) from inside a render pass
      setTimeout(() => loadDoc(docs[0].name), 0);
    }
    const list = el("div", { class: "doc-list" });
    for (const d of docs) {
      list.appendChild(el("button", {
        class: "doc-item" + (state.docSel === d.name ? " active" : ""),
        onclick: () => { state.docSel = d.name; loadDoc(d.name); repaintRight(); } },
        el("div", { class: "doc-title" }, d.title || d.name),
        el("div", { class: "doc-meta" }, d.name + (d.size ? "  ·  " + fmtBytes(d.size) : ""))));
    }
    const b = state.docBody;
    let view;
    if (!b || b.name !== state.docSel || b.loading) view = tabLoading();
    else if (b.error) view = tabError(b.error, () => loadDoc(state.docSel, true));
    else view = el("article", { class: "md", html: mdToHtml(b.markdown || "") });
    return el("div", { class: "split-pane" }, list, el("div", { class: "pane-body md-scroll" }, view));
  });
}

async function loadDoc(name, force) {
  if (!state.project || !name) return;
  if (!force && state.docBody && state.docBody.name === name && !state.docBody.error) return;
  const id = state.project.id;
  state.docBody = { name, loading: true };
  if (state.tab === "goals") repaintRight();
  let next;
  try { const r = await api.projectDoc(id, name); next = { name, markdown: (r && r.markdown) || "" }; }
  catch (e) {
    next = (e instanceof NotFoundError || (e && e.name === "NotFoundError"))
      ? { name, markdown: "" } : { name, error: (e && e.message) || "Could not load this document." };
  }
  if (!state.project || state.project.id !== id || state.docSel !== name) return;
  state.docBody = next;
  if (state.tab === "goals") repaintRight();
}

// ----- Code: repo file tree + viewer -----
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
const baseName = (p) => String(p || "").replace(/\/+$/, "").split("/").pop() || p;
// Several endpoints report memory as a raw byte count; show it human-readable but
// pass anything already formatted (e.g. "48 MiB") straight through.
const maybeBytes = (v) => (typeof v === "number" && isFinite(v) ? fmtBytes(v) : cellText(v));

function codeTab() {
  return withTab("code", (data) => {
    const entries = (data.entries || []).slice()
      .sort((a, b) => (a.type === b.type ? String(a.path).localeCompare(String(b.path)) : a.type === "dir" ? -1 : 1));
    const tree = el("div", { class: "doc-list" });

    // breadcrumb / up
    const cur = state.codePath || "";
    tree.appendChild(el("div", { class: "tree-crumb", title: cur || "/" }, "/" + cur));
    if (cur) {
      tree.appendChild(el("button", { class: "doc-item up",
        onclick: () => { state.codePath = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : ""; loadTab("code", { force: true }); } },
        el("div", { class: "doc-title" }, "↩  ..")));
    }
    if (!entries.length) {
      tree.appendChild(el("div", { class: "empty" }, "Empty."));
    }
    for (const e of entries) {
      const isDir = e.type === "dir" || e.type === "tree" || e.type === "directory";
      tree.appendChild(el("button", {
        class: "doc-item" + (!isDir && state.codeFile && state.codeFile.path === e.path ? " active" : ""),
        onclick: () => {
          if (isDir) { state.codePath = e.path; loadTab("code", { force: true }); }
          else { loadFile(e.path); }
        } },
        el("div", { class: "doc-title" }, (isDir ? "📁  " : "📄  ") + baseName(e.path)),
        !isDir && e.size != null ? el("div", { class: "doc-meta" }, fmtBytes(e.size)) : null));
    }

    const f = state.codeFile;
    let view;
    if (!f) view = tabEmpty("Pick a file to read its contents.");
    else if (f.loading) view = tabLoading();
    else if (f.error) view = tabError(f.error, () => loadFile(f.path, true));
    else {
      view = el("div", { class: "filepane" },
        el("div", { class: "file-head" },
          el("span", { class: "file-path" }, f.path),
          f.size != null ? el("span", { class: "file-size" }, fmtBytes(f.size)) : null),
        f.truncated ? el("div", { class: "notice" },
          "This file was truncated — only the first part is shown.") : null,
        el("pre", { class: "file-body" }, el("code", {}, f.content || "")));
    }
    return el("div", { class: "split-pane" }, tree, el("div", { class: "pane-body" }, view));
  });
}

async function loadFile(path, force) {
  if (!state.project || !path) return;
  if (!force && state.codeFile && state.codeFile.path === path && !state.codeFile.error) return;
  const id = state.project.id;
  state.codeFile = { path, loading: true };
  if (state.tab === "code") repaintRight();
  let next;
  try {
    const r = await api.projectFile(id, path);
    next = { path, content: (r && r.content) || "", size: r && r.size, truncated: !!(r && r.truncated) };
  } catch (e) {
    next = (e instanceof NotFoundError || (e && e.name === "NotFoundError"))
      ? { path, content: "", size: 0, truncated: false }
      : { path, error: (e && e.message) || "Could not read this file." };
  }
  if (!state.project || state.project.id !== id) return;
  state.codeFile = next;
  if (state.tab === "code") repaintRight();
}

// ----- Database -----
function databaseTab() {
  return withTab("database", (data) => {
    const tables = data.tables || [];
    const migs = data.migrations || [];
    if (!tables.length && !migs.length) return tabEmpty("No schema yet — the pipeline designs the data model as it builds.");
    const pane = tabPane();
    for (const t of tables) {
      pane.appendChild(el("div", { class: "card-block" },
        el("div", { class: "cb-head" },
          el("span", { class: "cb-title mono" }, cellText(t.name)),
          el("span", { class: "cb-badge" }, cellText(t.rows) + " rows")),
        recordsTable(t.columns || [], ["name", "type", "nullable"], {
          nullable: (v) => v === false ? "NOT NULL" : v === true ? "nullable" : cellText(v),
        })));
    }
    if (migs.length) {
      pane.appendChild(el("div", { class: "card-block" },
        el("div", { class: "cb-head" }, el("span", { class: "cb-title" }, "Migrations")),
        recordsTable(migs.map((m) => (typeof m === "string" ? { name: m } : m)), ["name", "applied_at"])));
    }
    return pane;
  });
}

// ----- Secrets: masked by default, explicit reveal -----
function secretsTab() {
  return withTab("secrets", (data) => {
    const secrets = data.secrets || [];
    const bar = tabToolbar(
      el("div", { class: "tt-note" }, state.secretsRevealed
        ? "Values are visible — don't share this screen."
        : "Values are masked."),
      el("div", { class: "spacer" }),
      el("button", { class: "btn sm" + (state.secretsRevealed ? " primary" : ""),
        onclick: () => { state.secretsRevealed = !state.secretsRevealed; loadTab("secrets", { force: true }); } },
        state.secretsRevealed ? "Hide values" : "Reveal values"));
    if (!secrets.length) return tabPane(bar, tabEmpty("No secrets yet — they're generated when the stack is provisioned."));
    const rows = el("div", { class: "kv-list" });
    for (const s of secrets) {
      const shown = state.secretsRevealed && s.value != null ? String(s.value) : String(s.masked || "••••••••");
      rows.appendChild(el("div", { class: "kv-row" },
        el("div", { class: "kv-key mono" }, cellText(s.key)),
        el("div", { class: "kv-val mono" }, shown),
        el("button", { class: "btn ghost sm", title: "Copy to clipboard",
          onclick: () => copyText(state.secretsRevealed && s.value != null ? String(s.value) : String(s.masked || "")) }, "Copy")));
    }
    return tabPane(bar, rows);
  });
}

function copyText(t) {
  if (!t) return;
  const done = () => toast("Copied.", "ok");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, () => toast("Could not copy.", "err"));
    return;
  }
  const ta = el("textarea", { style: "position:fixed;opacity:0" });
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { toast("Could not copy.", "err"); }
  ta.remove();
}

// ----- Logs -----
let logsTimer = null;
function setLogsAuto(on) {
  state.logsAuto = on;
  clearInterval(logsTimer); logsTimer = null;
  if (on) logsTimer = setInterval(() => {
    if (state.tab !== "logs" || !state.project) { clearInterval(logsTimer); logsTimer = null; state.logsAuto = false; return; }
    loadTab("logs", { force: true });
  }, 5000);
  repaintRight();
}

function logsTab() {
  return withTab("logs", (data) => {
    const lines = data.lines || [];
    const bar = tabToolbar(
      el("div", { class: "tt-note" }, lines.length ? lines.length + " lines" : ""),
      el("div", { class: "spacer" }),
      el("label", { class: "tt-check" },
        (() => { const i = el("input", { type: "checkbox" }); i.checked = !!state.logsAuto;
                 i.addEventListener("change", () => setLogsAuto(i.checked)); return i; })(),
        el("span", {}, "Auto-refresh")),
      el("button", { class: "btn sm", onclick: () => loadTab("logs", { force: true }) }, "↻ Refresh"));
    if (!lines.length) return tabPane(bar, tabEmpty("No logs yet — the container hasn't produced output."));
    // newest at the BOTTOM; the pane scrolls itself to the end after mount
    const pre = el("pre", { class: "logbox" }, lines.map(cellText).join("\n"));
    // newest line at the bottom -> park the scroll there
    setTimeout(() => {
      const sc = document.querySelector(".right-body .tab-pane");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }, 0);
    return tabPane(bar, pre);
  });
}

// ----- the remaining list-shaped tabs -----
// ---- Usage & Cost -------------------------------------------------------------
// Token accounting for this project. OpenRouter reports REAL cost when available; a row
// is flagged as estimated only when the provider didn't return one.
function usageTab() {
  const d = state.tabs.usage && state.tabs.usage.data;
  if (!d || !d.totals) return tabEmpty("No LLM usage recorded yet — it appears as the build runs.");
  const t = d.totals;
  const n = (x) => Number(x || 0).toLocaleString();
  const usd = (x) => "$" + Number(x || 0).toFixed(4);
  const cards = el("div", { class: "usage-cards" },
    usageCard("Input tokens", n(t.prompt_tokens), t.cached_tokens ? n(t.cached_tokens) + " cached" : ""),
    usageCard("Output tokens", n(t.completion_tokens), ""),
    usageCard("Total tokens", n(t.total_tokens), n(t.calls) + " calls"),
    usageCard("Cost", usd(t.cost_usd), t.cost_estimated ? "estimated" : "billed by provider"));
  const rows = (d.by_step || []).map((r) => el("tr", {},
    el("td", {}, r.step),
    el("td", { class: "num" }, n(r.prompt_tokens)),
    el("td", { class: "num" }, n(r.completion_tokens)),
    el("td", { class: "num" }, n(r.cached_tokens)),
    el("td", { class: "num" }, usd(r.cost_usd))));
  const table = el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", {}, "Step"), el("th", { class: "num" }, "In"),
      el("th", { class: "num" }, "Out"), el("th", { class: "num" }, "Cached"),
      el("th", { class: "num" }, "Cost"))),
    el("tbody", {}, ...rows)));
  return el("div", { class: "tab-pane" }, cards,
    el("div", { class: "muted-note" }, "Model: " + (t.model || "—")), table);
}

function usageCard(label, value, sub) {
  return el("div", { class: "usage-card" },
    el("div", { class: "uc-label" }, label),
    el("div", { class: "uc-value" }, value),
    sub ? el("div", { class: "uc-sub" }, sub) : null);
}

function commitsTab() {
  return withTab("commits", (data) => {
    const rows = data.commits || [];
    if (!rows.length) return tabEmpty("No commits yet — the pipeline pushes as it builds.");
    return tabPane(recordsTable(rows, ["sha", "message", "author", "date"], {
      sha: (v, r) => r && r.url
        ? el("a", { class: "mono", href: r.url, target: "_blank", rel: "noopener" }, cellText(v))
        : el("span", { class: "mono" }, cellText(v)),
      date: (v) => fmtDate(v) || cellText(v),
    }, ["url"]));
  });
}
function deploymentsTab() {
  return withTab("deployments", (data) => {
    const rows = data.deployments || [];
    if (!rows.length) return tabEmpty("No deployments recorded yet.");
    return tabPane(recordsTable(rows, ["id", "status", "health", "image", "started_at", "finished_at"], {
      status: (v) => statusPill(v),
    }));
  });
}
function qaTab() {
  return withTab("qa", (data) => {
    const rows = data.rounds || [];
    if (!rows.length) return tabEmpty("No QA rounds yet — chrome-pool exercises the app after each deploy.");
    return tabPane(recordsTable(rows, ["round", "status", "findings", "summary", "ts"], {
      ts: (v) => fmtDate(v) || cellText(v),
    }));
  });
}
function backlogTab() {
  return withTab("backlog", (data) => {
    const rows = data.items || [];
    if (!rows.length) return tabEmpty("No backlog yet — the pipeline plans the feature list as it builds.");
    const list = el("div", { class: "kv-list" });
    for (const it of rows) {
      const st = String(it.status || "").toLowerCase();
      list.appendChild(el("div", { class: "kv-row backlog-row" },
        el("span", { class: "bl-idx mono" }, cellText(it.idx)),
        el("span", { class: "bl-title" }, cellText(it.title)),
        el("span", { class: "bl-status s-" + st }, cellText(it.status))));
    }
    return tabPane(list);
  });
}
function routesTab() {
  return withTab("routes", (data) => {
    const rows = data.routes || [];
    if (!rows.length) return tabEmpty("No routes discovered yet.");
    const list = el("div", { class: "kv-list" });
    for (const r of rows) {
      list.appendChild(el("div", { class: "kv-row" },
        el("span", { class: "method m-" + String(r.method || "").toLowerCase() }, cellText(r.method)),
        el("span", { class: "kv-val mono" }, cellText(r.path))));
    }
    return tabPane(list);
  });
}
function metricsTab() {
  return withTab("metrics", (data) => {
    const rows = data.containers || [];
    if (!rows.length) return tabEmpty("No container metrics yet.");
    return tabPane(recordsTable(rows, ["name", "status", "cpu_pct", "mem_used", "mem_limit"], {
      name: (v) => el("span", { class: "mono" }, cellText(v)),
      cpu_pct: (v) => (typeof v === "number" ? v.toFixed(1) + " %" : cellText(v)),
      mem_used: maybeBytes,
      mem_limit: maybeBytes,
    }));
  });
}
function cacheTab() {
  return withTab("cache", (data) => {
    const keys = data.keys || [];
    const stats = el("div", { class: "stat-row" },
      el("div", { class: "stat" }, el("div", { class: "stat-n" }, cellText(data.dbsize)),
        el("div", { class: "stat-l" }, "Keys")),
      el("div", { class: "stat" }, el("div", { class: "stat-n" }, maybeBytes(data.used_memory)),
        el("div", { class: "stat-l" }, "Memory used")));
    if (!keys.length) return tabPane(stats, tabEmpty("No cache keys — nothing has been cached yet."));
    const list = el("div", { class: "kv-list" });
    for (const k of keys) list.appendChild(el("div", { class: "kv-row" },
      el("span", { class: "kv-val mono" }, cellText(k))));
    return tabPane(stats, list);
  });
}
function domainTab() {
  return withTab("domain", (data) => {
    if (!data || (!data.url && !data.subdomain)) return tabEmpty("No domain assigned yet.");
    const rows = [
      ["URL", data.url ? el("a", { href: data.url, target: "_blank", rel: "noopener", class: "mono" }, data.url) : "—"],
      ["Subdomain", el("span", { class: "mono" }, cellText(data.subdomain))],
      ["Certificate", el("span", { class: "mono" }, cellText(data.cert_subject))],
      ["Expires", cellText(data.cert_expires ? (fmtDate(data.cert_expires) || data.cert_expires) : null)],
    ];
    const list = el("div", { class: "kv-list" });
    for (const [k, v] of rows) list.appendChild(el("div", { class: "kv-row" },
      el("div", { class: "kv-key" }, k), el("div", { class: "kv-val" }, v)));
    return tabPane(list);
  });
}
function envTab() {
  return withTab("env", (data) => {
    const rows = data.env || [];
    if (!rows.length) return tabEmpty("No environment variables set.");
    const list = el("div", { class: "kv-list" });
    for (const e of rows) list.appendChild(el("div", { class: "kv-row" },
      el("div", { class: "kv-key mono" }, cellText(e.key)),
      el("div", { class: "kv-val mono" }, cellText(e.value)),
      el("button", { class: "btn ghost sm", onclick: () => copyText(String(e.value ?? "")) }, "Copy")));
    return tabPane(list);
  });
}

// ----- Danger Zone: lifecycle control; destroy demands the app id typed out -----
function dangerTab() {
  const proj = state.project;
  const busy = state.danger.busy;
  const act = (action) => async () => {
    if (busy) return;
    state.danger.busy = true; repaintRight();
    try {
      await api.lifecycle(proj.id, action);
      toast(action === "destroy" ? "App destroyed." : "Sent: " + action, "ok");
      if (action === "destroy") { await loadProjects().catch(() => {}); newProject(); return; }
      try { adoptProject(await api.getProject(proj.id)); } catch {}
      state.previewNonce++;
    } catch (e) {
      toast((e && e.message) || "That action failed.", "err");
    }
    state.danger.busy = false; state.danger.confirm = "";
    if (state.tab === "danger") repaintRight();
  };

  const confirmInput = el("input", { class: "danger-input", placeholder: "type " + proj.id + " to confirm",
    autocomplete: "off", spellcheck: "false" });
  confirmInput.value = state.danger.confirm || "";
  confirmInput.addEventListener("input", () => {
    state.danger.confirm = confirmInput.value;
    destroyBtn.disabled = confirmInput.value.trim() !== proj.id;
  });
  const destroyBtn = el("button", { class: "btn danger", onclick: () => {
    if (confirmInput.value.trim() !== proj.id) return;
    act("destroy")();
  } }, busy ? "Working…" : "Destroy this app");
  destroyBtn.disabled = (state.danger.confirm || "").trim() !== proj.id;

  return tabPane(
    el("div", { class: "card-block" },
      el("div", { class: "cb-head" }, el("span", { class: "cb-title" }, "Lifecycle")),
      el("p", { class: "cb-note" }, "Stop frees the containers; the data volumes are kept. Restart re-creates them from the last deployed image."),
      el("div", { class: "danger-actions" },
        el("button", { class: "btn sm", disabled: busy, onclick: act("stop") }, "Stop"),
        el("button", { class: "btn sm", disabled: busy, onclick: act("start") }, "Start"),
        el("button", { class: "btn sm", disabled: busy, onclick: act("restart") }, "Restart"))),
    el("div", { class: "card-block danger-block" },
      el("div", { class: "cb-head" }, el("span", { class: "cb-title bad" }, "Destroy")),
      el("p", { class: "cb-note" }, "This removes the containers, the database, the volumes and the subdomain. It cannot be undone."),
      el("div", { class: "danger-actions" }, confirmInput, destroyBtn)));
}

function urlPill(proj) {
  const url = proj.url || appUrl(proj);
  return el("div", { class: "url-pill", title: url },
    isMock() ? el("span", {}, url) : el("a", { href: url, target: "_blank", rel: "noopener" }, url));
}

// Live preview of the deployed app. Reloads (via a nonce) as deploys land. In mock mode
// there is no real host, so show a friendly placeholder frame instead of a 502.
function previewIframe(proj) {
  const url = proj.url || appUrl(proj);
  const frame = el("iframe", { class: "preview-frame", title: "Live app preview",
    sandbox: "allow-scripts allow-forms allow-popups allow-same-origin" });
  if (isMock()) {
    frame.srcdoc = `<!doctype html><body style="font-family:system-ui;color:#334;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7fb">
      <div style="text-align:center"><h2 style="margin:0 0 6px">${esc(proj.title || "Your app")}</h2>
      <p style="color:#889">Mock preview — the live app would render here at<br><code>${esc(url)}</code></p></div></body>`;
  } else {
    // Cache-bust so the frame re-fetches after a redeploy.
    frame.src = url + (url.includes("?") ? "&" : "?") + "_r=" + state.previewNonce;
  }
  return frame;
}

function placeholder() {
  return el("div", { class: "placeholder" },
    el("div", { class: "inner" },
      el("div", { class: "big" }, "✦"),
      el("h2", {}, "Your app will appear here"),
      el("p", {}, "Describe the app you want in the chat on the left. You'll watch the pipeline build it, then see it live in this preview.")));
}

// ---------- actions ----------
async function loadProjects() {
  await guard(async () => { state.projects = (await api.listProjects()) || []; });
}

// Populate the composer with an example prompt (chips don't auto-send — the user
// can tweak the wording, then press Send).
function fillComposer(text) {
  const ta = document.getElementById("prompt");
  if (!ta) return;
  ta.value = text;
  autoGrow(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// The one entry point for the composer (and example chips). First message with no
// project -> create; every message after -> request a change (update pipeline).
function sendMessage(text) {
  text = (text || "").trim();
  if (!text || state.generating) return;
  pushMessage("user", { text });
  if (state.project) onUpdate(text);
  else onCreate(text);
}

function finalizeLiveMsg(text, kind) {
  if (!liveMsg) return;
  for (const s of liveMsg.steps) s.pending = false;
  if (text) liveMsg.text = text;
  if (kind) liveMsg.kind = kind;
  liveMsg = null;
  persistMessages();
}

// Shared SSE handler for both create + update pipelines. Narrates each step into the
// live assistant bubble, tracks the live app URL + status, and reloads the preview as
// deploys land. Tolerates unknown event types gracefully.
function makeStreamHandler() {
  state.live = { steps: [], url: state.project ? state.project.url : null, statusText: "creating" };
  return (evt) => {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "created": {
        // First event: gives id + the live app URL. Adopt a project shell immediately
        // so the preview iframe + status pill light up.
        const url = evt.url || (evt.id ? appUrl({ id: evt.id }) : null);
        state.live.url = url;
        if (!state.project && evt.id) {
          state.project = { id: evt.id, title: currentTitle(), status: "creating",
                            subdomain: evt.id, url, pipeline: "create" };
          state.openTabs = loadOpenTabs(evt.id);
        } else if (state.project && url) {
          state.project.url = url;
        }
        // Put the id in the URL NOW so a mid-build reload rehydrates this project
        // instead of landing on an empty /builder.
        stampBuilderUrl(state.project ? state.project.id : evt.id);
        persistMessages();          // the opening prompt is now attachable to an id
        addStatusLine("Provisioning `" + (evt.id || "app") + "` at " + (url || "its URL"), { done: true });
        render();
        break;
      }
      case "step_start":
        state.live.statusText = "building";
        addStatusLine(textOf(evt.name) || ("Step " + (evt.idx != null ? evt.idx + 1 : "")));
        break;
      case "step_done": {
        const skipped = evt.skipped ? " · skipped" : "";
        const name = textOf(evt.name);
        if (name) addStatusLine(name + skipped, { done: true });
        else completeLastLine();
        break;
      }
      case "progress": {
        const stage = textOf(evt.stage) || textOf(evt);
        const detail = evt.detail ? " · `" + textOf(evt.detail) + "`" : "";
        if (stage) addStatusLine(stage + detail);
        break;
      }
      case "repo":
        if (evt.full_name) addStatusLine("Repo `" + textOf(evt.full_name) + "`", { done: true });
        break;
      case "deploy": {
        const url = evt.url || state.live.url;
        state.live.statusText = "deploying";
        if (url) { state.live.url = url; if (state.project) state.project.url = url; }
        addStatusLine("Deployed → " + (url || "live URL"), { done: true });
        // A deploy landed — reload the preview.
        state.previewNonce++;
        if (state.project) { state.project.status = "deploying"; render(); }
        break;
      }
      case "error":
        // surfaced by the promise rejection -> finalized as an error bubble
        break;
      default:
        // Unknown types (commit{...}, qa{...}, …): narrate a best-effort line if it
        // carries readable text, otherwise ignore. Never render "[object Object]".
        {
          const t = textOf(evt.message) || textOf(evt.stage) || textOf(evt.name);
          if (t) addStatusLine(t);
        }
        break;
    }
  };
}

function currentTitle() {
  // Best-effort title from the most recent user message.
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === "user") return state.messages[i].text.slice(0, 48);
  }
  return "New app";
}

async function onCreate(prompt) {
  prompt = (prompt || "").trim();
  if (!prompt) return;
  state.generating = true;
  stopStepPolling();
  state.runHistory = null;   // the live bubble now narrates the run
  liveMsg = pushMessage("assistant", { steps: [{ label: "Starting the build pipeline", pending: true }] });
  render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    await api.createProjectStream({ prompt }, onEvent);
    // Refresh the authoritative project row + list after the stream closes.
    if (state.project) {
      try { const fresh = await api.getProject(state.project.id); adoptProject(fresh); } catch {}
    }
    const url = (state.project && state.project.url) || (state.live && state.live.url) || "your app";
    finalizeLiveMsg(`✓ Build finished. Your app is live at ${url}. Tell me what to change.`);
    state.previewNonce++;
    invalidateTabs();
    await loadProjects();
    render();
    toast("App built.", "ok");
  }).catch((e) => {
    finalizeLiveMsg("Sorry — the build failed. " + (e && e.message ? e.message : "Please try again."), "error");
    if (state.project) state.project.status = "failed";
    render();
  });
  state.generating = false; state.live = null; liveMsg = null; render();
}

async function onUpdate(request) {
  if (!state.project) return;
  const id = state.project.id;
  state.generating = true;
  stopStepPolling();
  state.runHistory = null;   // the live bubble now narrates the run
  liveMsg = pushMessage("assistant", { steps: [{ label: "Starting the update pipeline", pending: true }] });
  render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    try {
      await api.updateProjectStream(id, request, onEvent);
    } catch (e) {
      if (e instanceof NotFoundError) {
        finalizeLiveMsg("Change requests are coming soon for this app — the update pipeline isn't wired up yet.", "");
        toast("Changes coming soon.", "");
        return;
      }
      throw e;
    }
    try { const fresh = await api.getProject(id); adoptProject(fresh); } catch {}
    finalizeLiveMsg("✓ Change applied and redeployed. Anything else?");
    state.previewNonce++;
    invalidateTabs();
    await loadProjects();
    render();
    toast("Change applied.", "ok");
  }).catch((e) => {
    finalizeLiveMsg("Sorry — that change didn't apply. " + (e && e.message ? e.message : ""), "error");
    render();
  });
  state.generating = false; state.live = null; liveMsg = null; render();
}

// Adopt an authoritative project row (from GET /api/projects/{id}) into state,
// synthesizing the URL if the row omitted it.
function adoptProject(proj) {
  if (!proj) return;
  if (!proj.url) proj.url = appUrl(proj);
  state.project = proj;
}

// Opening a project from the Apps list: push /builder/<id>, then hydrate.
function openProject(id) {
  goBuilder(false, id);
  return enterProject(id, { navigate: false });
}

// Clear the builder back to its empty state (bare /builder, or a brand-new app).
function resetBuilder() {
  stopStepPolling();
  clearInterval(logsTimer); logsTimer = null; state.logsAuto = false;
  state.project = null;
  state.live = null;
  state.messages = [];
  state.runHistory = null;
  state.previewNonce = 0;
  state.tab = "site";
  state.openTabs = [];
  state.tabs = {};
  state.docSel = null; state.docBody = null;
  state.codePath = ""; state.codeFile = null;
  state.secretsRevealed = false;
  state.danger = { busy: false, confirm: "" };
}

// THE FIX for "reloading /builder wipes everything": the full workspace is rebuilt
// FROM THE SERVER for the id in the URL — the chat thread from `messages`, the
// executed pipeline steps from `latest_run.steps`, plus status pill and preview.
async function enterProject(id, { navigate = true } = {}) {
  if (!id) return;
  resetBuilder();
  state.hydrating = true;
  state.view = "builder";
  if (navigate) goBuilder(false, id); else render();

  let proj;
  try {
    proj = await api.getProject(id);
  } catch (e) {
    state.hydrating = false;
    if (e instanceof AuthError) {
      toast("Session expired — signing you back in…");
      auth.clear(); setTimeout(() => auth.login(), 600);
      return;
    }
    if (e instanceof NotFoundError || (e && e.name === "NotFoundError")) {
      toast("That app doesn't exist (or isn't yours).", "err");
      goEntry(true);
      return;
    }
    toast((e && e.message) || "Could not open that app.", "err");
    render();
    return;
  }

  adoptProject(proj);
  state.openTabs = loadOpenTabs(id);
  state.previewNonce++;
  hydrateThread(proj);
  state.runHistory = runToHistory(proj.latest_run);
  state.hydrating = false;
  render();

  // The executed step list is NOT allowed to depend on the project row carrying
  // latest_run.steps. If it didn't, ask the dedicated endpoint and paint them in.
  if (!state.runHistory || !state.runHistory.steps.length) backfillSteps(id);

  // A run that is still executing must not be left as a dead, frozen list.
  maybeResumeRun();
}

// Second source for the executed steps: GET /api/projects/{id}/steps. Runs after
// the first paint so it can never delay or block the workspace.
async function backfillSteps(id) {
  if (!api.projectSteps) return;
  let sr;
  try { sr = await api.projectSteps(id); } catch { return; }
  if (!sr || !(sr.steps || []).length) return;
  if (!state.project || state.project.id !== id || state.generating) return;
  if (state.runHistory && state.runHistory.steps.length) return;   // already painted
  const base = state.project.latest_run || {};
  state.runHistory = runToHistory({ kind: base.kind, request: base.request,
                                    status: base.status, steps: sr.steps });
  repaintLeft();
}

// Rebuild the conversation. Server `messages` is the authority; sessionStorage is
// only a fallback for when the endpoint isn't reachable; failing both, we
// synthesize an honest thread from the project's own prompt + status.
function hydrateThread(proj) {
  const norm = (arr) => (arr || [])
    .filter((m) => m && typeof m === "object" && String(m.text || "").trim())
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant",
                   text: String(m.text), steps: [], kind: "" }));

  let msgs = norm(Array.isArray(proj.messages) ? proj.messages : null);
  if (!msgs.length) msgs = norm(loadThread(proj.id));
  if (!msgs.length) {
    msgs = [];
    if (proj.prompt) msgs.push({ role: "user", text: String(proj.prompt), steps: [], kind: "" });
    const statusLine = proj.status === "live"
      ? `Opened **${proj.title || proj.id}** — it's live at ${proj.url}. What should I change?`
      : `Opened **${proj.title || proj.id}** (status: ${proj.status || "unknown"}). What should I change?`;
    msgs.push({ role: "assistant", text: statusLine, steps: [], kind: "" });
  }
  state.messages = msgs;
}

// After a pipeline run lands, everything a tab shows (files, commits, schema,
// logs, deployments) may have changed — drop the lazy cache and refetch what's open.
function invalidateTabs() {
  state.tabs = {};
  state.docBody = null;
  state.codeFile = null;
  if (state.project && state.tab !== "site") loadTab(state.tab, { force: true });
}

// ---------- resuming a run that is still executing ----------
// The SSE stream belongs to the request that started it; after a reload it is gone.
// So poll the run until it finishes rather than showing a permanent spinner.
let stepPoll = null;
function stopStepPolling() { if (stepPoll) { clearInterval(stepPoll); stepPoll = null; } }

function maybeResumeRun() {
  stopStepPolling();
  if (state.generating || !state.project) return;
  const run = state.project.latest_run;
  const running = run && (run.status === "running" || run.status === "queued");
  const projBusy = ["creating", "building", "deploying"].includes(String(state.project.status || "").toLowerCase());
  if (!running && !projBusy) return;

  const id = state.project.id;
  let misses = 0;
  // Each completed step produces new artifacts (strategy docs, migrations, files,
  // commits). A tab opened DURING the build would otherwise keep showing the empty
  // state it cached on first open — e.g. Goals looks permanently empty if you open it
  // before `strategy_artifacts` finishes. Track progress and refetch the open tab
  // whenever the pipeline advances, so panes fill in as the build produces them.
  let lastDone = -1;
  stepPoll = setInterval(async () => {
    if (!state.project || state.project.id !== id || state.generating) { stopStepPolling(); return; }
    let run2 = null;
    try {
      // The project row is authoritative for the run's STATUS (GET .../steps
      // returns {run_id, steps} only), and already carries the steps too.
      const fresh = await api.getProject(id);
      adoptProject(fresh);
      run2 = fresh.latest_run || null;
      // Only reach for the dedicated steps endpoint if the row didn't carry them.
      if (api.projectSteps && (!run2 || !(run2.steps || []).length)) {
        try {
          const sr = await api.projectSteps(id);
          if (sr && sr.steps) run2 = { ...(run2 || {}), steps: sr.steps };
        } catch (e) { if (!(e instanceof NotFoundError || (e && e.name === "NotFoundError"))) throw e; }
      }
    } catch {
      if (++misses >= 5) { stopStepPolling(); }   // stop hammering a dead endpoint
      return;
    }
    misses = 0;
    if (!run2) return;
    state.runHistory = runToHistory(run2);
    const runState = run2.status ||
      (["creating", "building", "deploying"].includes(String(state.project.status || "").toLowerCase())
        ? "running" : "done");
    const done = runState !== "running" && runState !== "queued";
    if (done) {
      stopStepPolling();
      try { adoptProject(await api.getProject(id)); } catch {}
      state.previewNonce++;
      invalidateTabs();
      loadProjects().catch(() => {});
      render();                 // the run landed: refresh the preview + status pill
      toast("Build finished.", "ok");
      return;
    }
    // Still running. Refresh the open tab whenever another step has completed, so a
    // pane opened mid-build (Goals/Code/Database) fills in instead of staying empty.
    const doneCount = (run2.steps || []).filter((s) => s.status === "done").length;
    if (doneCount !== lastDone) {
      if (lastDone >= 0 && state.tab && state.tab !== "site") {
        state.tabs = {};                          // drop the stale empty-state cache
        loadTab(state.tab, { force: true }).catch(() => {});
      }
      lastDone = doneCount;
    }
    repaintLeft();              // still running: only the step list changes
  }, 4000);
}

// Best-effort fetch of the OIDC userinfo for a richer Profile (name/email/avatar).
async function loadProfile() {
  if (isMock()) { state.profile = { name: "Demo user (mock)", email: "demo@osmike.com", sub: "mock-sub" }; return; }
  const t = auth.token();
  if (!t) return;
  try {
    const r = await fetch(CFG.ISSUER + "/oauth/userinfo", { headers: { Authorization: "Bearer " + t } });
    if (r.ok) { state.profile = await r.json(); if (SHELL_VIEWS.has(state.view)) render(); }
  } catch { /* fall back to token claims */ }
}

// ---------- boot ----------
async function boot() {
  applyTheme();
  render();  // shows boot spinner

  let cameFromCallback = false;
  // If we're on the OAuth callback, finish the exchange first.
  if (location.pathname === "/auth/callback" || new URLSearchParams(location.search).has("code")) {
    if (!isMock()) {
      const ok = await auth.handleCallback();
      history.replaceState(null, "", "/");
      cameFromCallback = ok;
      if (!ok) { state.booting = false; render(); return; }
    } else {
      history.replaceState(null, "", "/");
    }
  }

  if (!isMock() && !auth.isAuthed()) { state.booting = false; syncViewFromPath(); render(); return; }

  const deepId = syncViewFromPath();
  await loadProjects();
  loadProfile();                 // fire-and-forget; Profile view re-reads state.profile
  state.booting = false;

  // Resume a prompt the user submitted before logging in (stashed pre-redirect).
  let pending = null;
  try { pending = sessionStorage.getItem(PENDING_KEY); } catch {}
  if (cameFromCallback && pending) {
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
    render();
    goBuilder(true, null);       // replaceState so back doesn't re-trigger
    pushMessage("user", { text: pending });
    onCreate(pending);
    return;
  }

  // Deep link / RELOAD of /builder/<id>: rebuild the whole workspace from the
  // server — chat thread, executed pipeline steps, status pill and preview.
  if (state.view === "builder" && deepId) { await enterProject(deepId, { navigate: false }); return; }

  render();
}

boot();
