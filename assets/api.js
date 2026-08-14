// api.js — thin client for builderapps-api.osmike.com. Sends Bearer on all calls
// except health. Includes a ?mock=1 stub so the full UI can run with no backend.
//
// Contract (dual-auth JWT/X-API-KEY; we send the OAuth Bearer):
//   GET  /api/health                       -> {status, database}
//   POST /api/projects {prompt, title?}     -> SSE stream (create pipeline)
//   GET  /api/projects                      -> {projects:[...]}
//   GET  /api/projects/{id}                 -> project row + latest_run(+steps) + messages + url
//   POST /api/projects/{id}/update {request}-> SSE stream (update pipeline; may 404)
//   PUT  /api/projects/{id}/messages {messages:[{role,text}]}  -> persist the chat thread
//   GET  /api/projects/{id}/steps           -> {steps:[...], status} (poll a running run)
// Workspace tabs (all GET /api/projects/{id}/...; any of them may 404 until the
// backend ships them — callers MUST degrade to an empty state, never an error):
//   /docs · /docs/{name} · /files?path= · /file?path= · /database · /secrets[?reveal=1]
//   /logs?tail= · /commits · /deployments · /qa · /backlog · /routes · /metrics
//   /cache · /domain · /env   and  POST /lifecycle {action}
import { auth } from "./auth.js";
import { mockApi } from "./mock.js";

const CFG = window.BUILDERAPPS_CONFIG;

export function isMock() {
  const q = new URLSearchParams(location.search);
  return CFG.MOCK === true || q.get("mock") === "1";
}

// Thrown so the UI can distinguish an auth failure (re-login) from other errors.
export class AuthError extends Error {}
// Thrown for a 404 so callers can degrade gracefully (e.g. update not deployed yet).
export class NotFoundError extends Error {}

async function req(method, path, body) {
  const headers = { "Accept": "application/json" };
  const t = auth.token();
  if (t) headers["Authorization"] = "Bearer " + t;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(CFG.API_BASE + path, opts);
  } catch (e) {
    throw new Error("Network error reaching builderapps-api. " + (e && e.message || ""));
  }
  if (r.status === 401 || r.status === 403) throw new AuthError("Session expired");
  if (r.status === 404) throw new NotFoundError("Not found");
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || ("HTTP " + r.status);
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// Generic Server-Sent-Events POST helper. Streams `data: {json}\n\n` frames, calling
// onEvent(evt) for EVERY event. Uses fetch (not EventSource) so we can send the Bearer
// token and a JSON body. Resolves when the stream closes; the caller reads the project
// state it accumulated from the events (there is no single "done" frame in this contract).
//
//   method:  "POST"
//   path:    e.g. "/api/projects"
//   payload: request body object
//   onEvent: (evt) => void   — evt.type distinguishes the frame
async function sseRequest(method, path, payload, onEvent) {
  const headers = { "Content-Type": "application/json", "Accept": "text/event-stream" };
  const t = auth.token();
  if (t) headers["Authorization"] = "Bearer " + t;
  let r;
  try {
    r = await fetch(CFG.API_BASE + path, { method, headers, body: JSON.stringify(payload || {}) });
  } catch (e) { throw new Error("Network error reaching builderapps-api. " + (e && e.message || "")); }
  if (r.status === 401 || r.status === 403) throw new AuthError("Session expired");
  if (r.status === 404) throw new NotFoundError("Not found");
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    let d = null; try { d = JSON.parse(text); } catch { /* */ }
    throw new Error((d && (d.detail || d.message)) || ("HTTP " + r.status));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", err = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      // An SSE frame may carry multiple `data:` lines; concatenate them.
      let dataStr = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      let evt; try { evt = JSON.parse(dataStr); } catch { continue; }
      if (evt.type === "error") err = evt.message || "Pipeline error";
      if (onEvent) { try { onEvent(evt); } catch { /* UI callback must not kill the stream */ } }
    }
  }
  if (err) throw new Error(err);
}

// Sub-resource helper: GET /api/projects/{id}/<tail>. `tail` may carry a query string.
const sub = (id, tail) => req("GET", `/api/projects/${encodeURIComponent(id)}/${tail}`);

const live = {
  health:        ()            => req("GET",  "/api/health"),
  listProjects:  ()            => req("GET",  "/api/projects").then((r) => (r && r.projects) || []),
  getProject:    (id)          => req("GET",  `/api/projects/${encodeURIComponent(id)}`),
  // Create pipeline — streams the ordered steps + progress; caller accumulates state.
  createProjectStream: (payload, onEvent) => sseRequest("POST", "/api/projects", payload, onEvent),
  // Update pipeline — same event shape; may 404 if not deployed yet (caller handles it).
  updateProjectStream: (id, request, onEvent) =>
    sseRequest("POST", `/api/projects/${encodeURIComponent(id)}/update`, { request }, onEvent),

  // --- durable chat thread (server-side source of truth) ---
  putMessages:   (id, messages) =>
    req("PUT", `/api/projects/${encodeURIComponent(id)}/messages`, { messages }),
  // --- poll a run that is still executing (used when the SSE stream is gone) ---
  projectSteps:  (id)          => sub(id, "steps"),

  // --- workspace tabs ---
  projectDocs:   (id)          => sub(id, "docs"),
  projectDoc:    (id, name)    => sub(id, `docs/${encodeURIComponent(name)}`),
  projectFiles:  (id, path)    => sub(id, `files?path=${encodeURIComponent(path || "")}`),
  projectFile:   (id, path)    => sub(id, `file?path=${encodeURIComponent(path || "")}`),
  projectDatabase:    (id)     => sub(id, "database"),
  projectSecrets:     (id, reveal) => sub(id, "secrets" + (reveal ? "?reveal=1" : "")),
  projectLogs:        (id, tail)   => sub(id, `logs?tail=${encodeURIComponent(tail || 200)}`),
  projectUsage:       (id)     => sub(id, "usage"),
  projectCommits:     (id)     => sub(id, "commits"),
  projectDeployments: (id)     => sub(id, "deployments"),
  projectQa:          (id)     => sub(id, "qa"),
  projectBacklog:     (id)     => sub(id, "backlog"),
  projectRoutes:      (id)     => sub(id, "routes"),
  projectMetrics:     (id)     => sub(id, "metrics"),
  projectCache:       (id)     => sub(id, "cache"),
  projectDomain:      (id)     => sub(id, "domain"),
  projectEnv:         (id)     => sub(id, "env"),
  lifecycle:     (id, action)  =>
    req("POST", `/api/projects/${encodeURIComponent(id)}/lifecycle`, { action }),

  // --- per-project AI assistants (phase 29) ---
  // The catalog is templates + the capability vocabulary. It is NOT a list of allowed
  // roles — `role` is free text and the API accepts anything; the templates only pre-fill.
  assistantsCatalog: ()        => req("GET", "/api/assistants/catalog"),
  assistants:        (id)      => sub(id, "assistants"),
  createAssistant:   (id, body) =>
    req("POST", `/api/projects/${encodeURIComponent(id)}/assistants`, body),
  assistant:         (id, aid) => sub(id, `assistants/${aid}`),
  patchAssistant:    (id, aid, body) =>
    req("PATCH", `/api/projects/${encodeURIComponent(id)}/assistants/${aid}`, body),
  deleteAssistant:   (id, aid) =>
    req("DELETE", `/api/projects/${encodeURIComponent(id)}/assistants/${aid}`),
  // action ∈ start | pause | beat  ("beat" returns as soon as the beat row exists)
  assistantAction:   (id, aid, action) =>
    req("POST", `/api/projects/${encodeURIComponent(id)}/assistants/${aid}/${action}`, {}),
  assistantBeats:    (id, aid) => sub(id, `assistants/${aid}/beats`),
};

// The exported client picks live or mock at module-load time.
export const api = isMock() ? mockApi : live;
