// app.js — mikeos-builderapps SPA controller. Vanilla ES modules, no framework.
// Describe an app -> watch the AI pipeline build it live -> see it deployed.
import { auth } from "/assets/auth.js";
import { api, isMock, AuthError, NotFoundError } from "/assets/api.js";

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
  entryDraft: "",     // the entry-screen textarea text (preserved across renders)
  profile: null,      // userinfo from account.osmike.com (best-effort)
  settings: loadSettings(),
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

function navigate(view, { replace = false } = {}) {
  state.view = view;
  const path = VIEW_PATH[view] || "/";
  const fn = replace ? "replaceState" : "pushState";
  if (location.pathname !== path) history[fn](null, "", path);
  render();
}
function goBuilder(replace) { navigate("builder", { replace: !!replace }); }
function goEntry(replace)   { navigate("entry",   { replace: !!replace }); }

// Sync the view to the current URL (back/forward, refresh, deep link).
function syncViewFromPath() {
  state.view = PATH_VIEW[location.pathname] || "entry";
}
window.addEventListener("popstate", () => { syncViewFromPath(); render(); });

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

// Persist the thread PER PROJECT in sessionStorage (the contract exposes no messages
// endpoint), so a reload/reopen within the session restores the conversation.
function threadKey(id) { return "builderapps_thread_" + id; }
function persistMessages() {
  if (!state.project) return;
  try { sessionStorage.setItem(threadKey(state.project.id), JSON.stringify(compactMessages())); } catch {}
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
  const u = isMock() ? { name: "Demo user (mock)", email: "demo@osmike.com" } : (auth.user() || {});
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
      const url = p.url || `https://${p.subdomain || p.id}.builderapps.osmike.com/`;
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
  state.project = null;
  state.live = null;
  state.messages = [];
  state.previewNonce = 0;
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
  if (!state.messages.length) thread.appendChild(chatIntro());
  else for (const m of state.messages) thread.appendChild(chatBubble(m));
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

// A compact live checklist: done lines get a check, the active (last) line spins.
function stepList(steps) {
  const list = el("div", { class: "chat-steps" });
  steps.forEach((s) => {
    const pending = s.pending !== false;
    list.appendChild(el("div", { class: "chat-step " + (pending ? "active" : "done") },
      pending ? el("span", { class: "spin sm" }) : el("span", { class: "chk" }, "✓"),
      el("span", { class: "cs-label", html: mdInline(s.label) })));
  });
  return list;
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

function rightPanel() {
  const proj = state.project;
  const status = state.generating && state.live ? (state.live.statusText || "building")
               : (proj && proj.status) || null;

  const head = el("div", { class: "right-head" },
    el("div", { class: "right-title" },
      el("span", {}, proj ? (proj.title || proj.id) : "Live preview"),
      status ? statusPill(status) : null),
    el("div", { class: "spacer" }),
    proj ? urlPill(proj) : null,
    proj ? el("button", { class: "btn sm", title: "Reload the live preview",
      onclick: () => { state.previewNonce++; render(); } }, "↻ Reload") : null,
    proj ? el("a", { class: "btn sm", href: proj.url, target: "_blank", rel: "noopener" }, "Open ↗") : null);

  const body = el("div", { class: "right-body" });
  if (proj) body.appendChild(previewIframe(proj));
  else body.appendChild(placeholder());

  return el("div", { class: "right" }, head, body);
}

function urlPill(proj) {
  const url = proj.url || `https://${proj.subdomain || proj.id}.builderapps.osmike.com/`;
  return el("div", { class: "url-pill", title: url },
    isMock() ? el("span", {}, url) : el("a", { href: url, target: "_blank", rel: "noopener" }, url));
}

// Live preview of the deployed app. Reloads (via a nonce) as deploys land. In mock mode
// there is no real host, so show a friendly placeholder frame instead of a 502.
function previewIframe(proj) {
  const url = proj.url || `https://${proj.subdomain || proj.id}.builderapps.osmike.com/`;
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
        const url = evt.url || (evt.id ? `https://${evt.id}.builderapps.osmike.com/` : null);
        state.live.url = url;
        if (!state.project && evt.id) {
          state.project = { id: evt.id, title: currentTitle(), status: "creating",
                            subdomain: evt.id, url, pipeline: "create" };
        } else if (state.project && url) {
          state.project.url = url;
        }
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
  if (!proj.url) proj.url = `https://${proj.subdomain || proj.id}.builderapps.osmike.com/`;
  state.project = proj;
}

async function openProject(id) {
  await guard(async () => {
    const proj = await api.getProject(id);
    adoptProject(proj);
    state.previewNonce++;
    // Restore the prior conversation for this project (session-scoped), else seed one.
    const saved = loadThread(id);
    if (saved.length) {
      state.messages = saved
        .filter((m) => m && (m.text || "").trim())
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text, steps: [], kind: "" }));
    } else {
      const statusLine = proj.status === "live"
        ? `Opened **${proj.title || id}** — it's live at ${proj.url}. What should I change?`
        : `Opened **${proj.title || id}** (status: ${proj.status || "unknown"}). What should I change?`;
      state.messages = [{ role: "assistant", text: statusLine, steps: [], kind: "" }];
    }
    goBuilder();             // opening an existing project lands in the builder view
  });
}

// Best-effort fetch of the OIDC userinfo for a richer Profile (name/email/avatar).
async function loadProfile() {
  if (isMock()) { state.profile = { name: "Demo user (mock)", email: "demo@osmike.com", sub: "mock-sub" }; return; }
  const t = auth.token();
  if (!t) return;
  try {
    const r = await fetch(CFG.ISSUER + "/oauth/userinfo", { headers: { Authorization: "Bearer " + t } });
    if (r.ok) { state.profile = await r.json(); if (state.view === "profile") render(); }
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

  syncViewFromPath();
  await loadProjects();
  loadProfile();                 // fire-and-forget; Profile view re-reads state.profile
  state.booting = false;

  // Resume a prompt the user submitted before logging in (stashed pre-redirect).
  let pending = null;
  try { pending = sessionStorage.getItem(PENDING_KEY); } catch {}
  if (cameFromCallback && pending) {
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
    render();
    goBuilder(true);             // replaceState so back doesn't re-trigger
    pushMessage("user", { text: pending });
    onCreate(pending);
    return;
  }

  render();
}

boot();
