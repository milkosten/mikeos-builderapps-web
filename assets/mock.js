// mock.js — in-memory stub of builderapps-api, active only with ?mock=1 (or CFG.MOCK).
// Emits the FULL create-pipeline SSE event sequence (created -> step_start/step_done
// pairs interleaved with progress/repo/deploy) so the whole UI can be exercised offline
// with no backend and no auth. NEVER used in production.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => (Math.random().toString(36) + "000000").slice(2, 8);

// The ordered pipeline steps a real create run streams (a representative subset).
const PIPELINE_STEPS = [
  "Allocate shortid + subdomain",
  "Create Gitea repo from template",
  "Checkout workspace + deploy key",
  "Bring up live skeleton",
  "Write strategy docs",
  "Design data model + migrations",
  "Build backend routes",
  "Build frontend pages",
  "Wire + style the app",
  "Deploy the stack",
  "Runtime QA (chrome-pool)",
  "Finalize",
];

const store = new Map();

function seed() {
  const id = "demo01";
  store.set(id, {
    id, title: "Recipe Box", status: "live", subdomain: id,
    url: `https://${id}.builderapps.osmike.com/`,
    pipeline: "create",
    repo: "milkosten/app-demo01",
    created_at: new Date(Date.now() - 864e5).toISOString(),
    updated_at: new Date(Date.now() - 3600e3).toISOString(),
    latest_run: { kind: "create", status: "done", current_step: PIPELINE_STEPS.length,
                  total_steps: PIPELINE_STEPS.length },
  });
}
seed();

function listShape(p) {
  return { id: p.id, title: p.title, status: p.status, subdomain: p.subdomain,
           pipeline: p.pipeline, url: p.url, created_at: p.created_at, updated_at: p.updated_at };
}

// Stream the pipeline events for a run into onEvent, mutating the stored project.
async function streamPipeline(p, onEvent, { steps = PIPELINE_STEPS } = {}) {
  const emit = (e) => { if (onEvent) { try { onEvent(e); } catch { /* */ } } };
  emit({ type: "created", id: p.id, url: p.url, run_id: "run-" + rid() });
  await wait(300);
  for (let idx = 0; idx < steps.length; idx++) {
    const name = steps[idx];
    p.status = idx < 3 ? "creating" : idx < 9 ? "building" : idx < 11 ? "deploying" : "live";
    p.updated_at = new Date().toISOString();
    emit({ type: "step_start", idx, name });
    await wait(260);
    // A couple of freeform progress narrations mid-step, to exercise the progress path.
    if (idx === 4) emit({ type: "progress", stage: "Writing Vision + Technical plan", detail: "docs/" });
    if (idx === 6) emit({ type: "progress", stage: "Generating Express routes", detail: "src/routes" });
    if (name === "Create Gitea repo from template") emit({ type: "repo", full_name: p.repo });
    if (name === "Deploy the stack") emit({ type: "deploy", url: p.url });
    await wait(180);
    emit({ type: "step_done", idx, name });
    await wait(120);
  }
  p.status = "live";
  p.updated_at = new Date().toISOString();
}

export const mockApi = {
  async health() { return { status: "ok", database: "ok" }; },

  async listProjects() {
    await wait(120);
    return [...store.values()]
      .sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))
      .map(listShape);
  },

  async getProject(id) {
    await wait(100);
    const p = store.get(id);
    if (!p) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    return { ...listShape(p), repo: p.repo, latest_run: p.latest_run };
  },

  async createProjectStream({ prompt, title }, onEvent) {
    await wait(400);
    const id = rid();
    const t = title || (prompt ? prompt.slice(0, 40) : "Untitled app");
    const p = {
      id, title: t, status: "creating", subdomain: id,
      url: `https://${id}.builderapps.osmike.com/`, pipeline: "create",
      repo: `milkosten/app-${id}`,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      latest_run: { kind: "create", status: "running", current_step: 0, total_steps: PIPELINE_STEPS.length },
    };
    store.set(id, p);
    await streamPipeline(p, onEvent);
    p.latest_run = { kind: "create", status: "done", current_step: PIPELINE_STEPS.length,
                     total_steps: PIPELINE_STEPS.length };
  },

  async updateProjectStream(id, request, onEvent) {
    const p = store.get(id);
    if (!p) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    const steps = ["Checkout latest", "Plan a minimal diff", "Apply the change",
                   "Rebuild the app", "Deploy the stack", "Runtime QA", "Finalize"];
    p.status = "building";
    await streamPipeline(p, onEvent, { steps });
    p.latest_run = { kind: "update", status: "done", current_step: steps.length, total_steps: steps.length };
  },
};
