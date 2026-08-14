// api.js — thin client for builderapps-api.osmike.com. Sends Bearer on all calls
// except health. Includes a ?mock=1 stub so the full UI can run with no backend.
//
// Contract (dual-auth JWT/X-API-KEY; we send the OAuth Bearer):
//   GET  /api/health                       -> {status, database}
//   POST /api/projects {prompt, title?}     -> SSE stream (create pipeline)
//   GET  /api/projects                      -> {projects:[...]}
//   GET  /api/projects/{id}                 -> project row + latest_run + url
//   POST /api/projects/{id}/update {request}-> SSE stream (update pipeline; may 404)
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

const live = {
  health:        ()            => req("GET",  "/api/health"),
  listProjects:  ()            => req("GET",  "/api/projects").then((r) => (r && r.projects) || []),
  getProject:    (id)          => req("GET",  `/api/projects/${encodeURIComponent(id)}`),
  // Create pipeline — streams the ordered steps + progress; caller accumulates state.
  createProjectStream: (payload, onEvent) => sseRequest("POST", "/api/projects", payload, onEvent),
  // Update pipeline — same event shape; may 404 if not deployed yet (caller handles it).
  updateProjectStream: (id, request, onEvent) =>
    sseRequest("POST", `/api/projects/${encodeURIComponent(id)}/update`, { request }, onEvent),
};

// The exported client picks live or mock at module-load time.
export const api = isMock() ? mockApi : live;
