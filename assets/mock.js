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

// Server-side chat threads (the mock stand-in for PUT/GET .../messages).
const threads = new Map();

// ---------------------------------------------------------------------------
// Mock workspace-tab fixtures. Every tab below has plausible ?mock=1 data so the
// whole tabbed workspace can be exercised with no backend at all.
// ---------------------------------------------------------------------------
const MOCK_DOCS = {
  "VISION.md": {
    title: "Vision",
    markdown: `# Vision — Recipe Box\n\nA place where a household keeps **every recipe it actually cooks**, instead of\nscattering them across screenshots, bookmarks and paper.\n\n## The problem\n\n- Recipes live in *five* different apps and none of them are searchable together.\n- Nobody remembers which version of grandma's stew was the good one.\n\n## What we build\n\n1. Add a recipe with a title, ingredients and steps.\n2. Search across everything instantly.\n3. Mark favourites and see what you cooked recently.\n\n> Success looks like: the printer stays off, and the family cooks from one list.\n\nSee the [technical plan](TECHNICAL-PLAN.md) for how this is built.\n`,
  },
  "ICP.md": {
    title: "Ideal customer profile",
    markdown: `# Ideal customer profile\n\n| Trait | Value |\n|---|---|\n| Who | Home cooks in a 2-5 person household |\n| Frequency | Cooks 4+ times a week |\n\n- **Primary:** the household "kitchen owner" who plans the week.\n- **Secondary:** partners and teenagers who just need tonight's recipe.\n\nThey are *not* professional chefs and will not tolerate a setup wizard.\n`,
  },
  "UX.md": {
    title: "UX notes",
    markdown: `# UX\n\n## Screens\n\n1. **List** — newest first, a search box pinned to the top.\n2. **Detail** — ingredients left, steps right, big type.\n3. **Editor** — one page, autosaves.\n\n\`\`\`\nlist -> detail -> editor -> list\n\`\`\`\n\nNo modal dialogs. Every destructive action is undoable for 10 seconds.\n`,
  },
  "BUYER-PERSONA.md": {
    title: "Buyer persona",
    markdown: `# Buyer persona — "Sara, 38"\n\nSara plans meals on Sunday evening. She has *tried* three recipe apps and\nabandoned all of them because importing was work.\n\n- **Job to be done:** get from "what's for dinner" to a shopping list in 2 minutes.\n- **Objection:** "I don't want another account."\n- **Trigger:** a recipe she liked and cannot find again.\n`,
  },
  "MARKETING.md": {
    title: "Marketing",
    markdown: `# Marketing\n\n## Positioning\n\n**One place for the recipes you actually cook.**\n\n## Channels\n\n- Word of mouth inside households (the app is shared, not personal).\n- A public recipe page that is genuinely nice to link to.\n\n### Copy fragments\n\n- "Stop screenshotting recipes."\n- "Your kitchen, one list."\n`,
  },
  "TECHNICAL-PLAN.md": {
    title: "Technical plan",
    markdown: `# Technical plan\n\n## Stack\n\n- Node 20 + Express\n- Postgres 16 (\`recipes\`, \`ingredients\`)\n- Redis for the search cache\n\n## Data model\n\n\`\`\`sql\nCREATE TABLE recipes (\n  id serial PRIMARY KEY,\n  title text NOT NULL,\n  body text,\n  created_at timestamptz DEFAULT now()\n);\n\`\`\`\n\n## Routes\n\n- \`GET /api/recipes\` — list, newest first\n- \`POST /api/recipes\` — create\n- \`DELETE /api/recipes/:id\` — remove\n\nAll SQL is **parameterized**; no value is ever interpolated into a statement.\n`,
  },
};

const MOCK_TREE = {
  "": [
    { path: "public", type: "dir", size: 0 },
    { path: "src", type: "dir", size: 0 },
    { path: "migrations", type: "dir", size: 0 },
    { path: "package.json", type: "file", size: 612 },
    { path: "README.md", type: "file", size: 1840 },
    { path: "Dockerfile", type: "file", size: 344 },
  ],
  "src": [
    { path: "src/index.js", type: "file", size: 2210 },
    { path: "src/db.js", type: "file", size: 940 },
    { path: "src/routes", type: "dir", size: 0 },
  ],
  "src/routes": [
    { path: "src/routes/recipes.js", type: "file", size: 1730 },
    { path: "src/routes/health.js", type: "file", size: 410 },
  ],
  "public": [
    { path: "public/index.html", type: "file", size: 5120 },
    { path: "public/app.js", type: "file", size: 3980 },
    { path: "public/styles.css", type: "file", size: 2260 },
  ],
  "migrations": [
    { path: "migrations/001_init.sql", type: "file", size: 480 },
    { path: "migrations/002_favourites.sql", type: "file", size: 210 },
  ],
};

const MOCK_FILES = {
  "package.json": `{\n  "name": "app-demo01",\n  "private": true,\n  "type": "module",\n  "scripts": { "start": "node src/index.js" },\n  "dependencies": {\n    "express": "^4.19.2",\n    "pg": "^8.11.5",\n    "redis": "^4.6.13"\n  }\n}\n`,
  "src/index.js": `import express from "express";\nimport { pool, migrate } from "./db.js";\nimport recipes from "./routes/recipes.js";\nimport health from "./routes/health.js";\n\nconst app = express();\napp.use(express.json());\napp.use(express.static("public"));\napp.use("/api/recipes", recipes);\napp.use("/api/health", health);\n\nawait migrate();\napp.listen(process.env.PORT || 3000, () => console.log("up"));\n`,
  "src/routes/recipes.js": `import { Router } from "express";\nimport { pool } from "../db.js";\n\nconst r = Router();\n\nr.get("/", async (_req, res) => {\n  const { rows } = await pool.query(\n    "SELECT id,title,body,created_at FROM recipes ORDER BY created_at DESC"\n  );\n  res.json({ recipes: rows });\n});\n\nr.post("/", async (req, res) => {\n  const { title, body } = req.body || {};\n  if (!title) return res.status(400).json({ error: "title required" });\n  const { rows } = await pool.query(\n    "INSERT INTO recipes(title,body) VALUES ($1,$2) RETURNING id",\n    [title, body || ""]\n  );\n  res.json({ id: rows[0].id });\n});\n\nexport default r;\n`,
  "migrations/001_init.sql": `CREATE TABLE IF NOT EXISTS recipes (\n  id         serial PRIMARY KEY,\n  title      text NOT NULL,\n  body       text,\n  created_at timestamptz NOT NULL DEFAULT now()\n);\n`,
};

const MOCK_TABS = {
  database: {
    tables: [
      { name: "recipes", rows: 42, columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "title", type: "text", nullable: false },
        { name: "body", type: "text", nullable: true },
        { name: "created_at", type: "timestamptz", nullable: false }] },
      { name: "favourites", rows: 7, columns: [
        { name: "recipe_id", type: "integer", nullable: false },
        { name: "marked_at", type: "timestamptz", nullable: false }] },
    ],
    migrations: [
      { name: "001_init.sql", applied_at: new Date(Date.now() - 3 * 864e5).toISOString() },
      { name: "002_favourites.sql", applied_at: new Date(Date.now() - 2 * 864e5).toISOString() },
    ],
  },
  secrets: {
    secrets: [
      { key: "DATABASE_URL", masked: "postgres://app:••••••••@db-demo01:5432/app", value: "postgres://app:s3cr3tpw@db-demo01:5432/app" },
      { key: "REDIS_URL", masked: "redis://redis-demo01:6379", value: "redis://redis-demo01:6379" },
      { key: "SESSION_SECRET", masked: "••••••••••••••••", value: "6f1c9a2e4b8d7e30a5c1f2b9d4e8a7c3" },
    ],
  },
  commits: {
    commits: [
      { sha: "9c1f2ab", message: "add a search box that filters recipes by title", author: "builderapps", date: new Date(Date.now() - 3600e3).toISOString(), url: "https://gitea.osmike.com/demo/app-demo01/commit/9c1f2ab" },
      { sha: "41de77b", message: "runtime QA fixes: empty-state copy + 404 handler", author: "builderapps", date: new Date(Date.now() - 7200e3).toISOString(), url: "https://gitea.osmike.com/demo/app-demo01/commit/41de77b" },
      { sha: "0ab93c5", message: "initial full-stack scaffold from template", author: "builderapps", date: new Date(Date.now() - 3 * 864e5).toISOString(), url: "https://gitea.osmike.com/demo/app-demo01/commit/0ab93c5" },
    ],
  },
  deployments: {
    deployments: [
      { id: 12, status: "live", health: "ok", image: "app-demo01:9c1f2ab", started_at: new Date(Date.now() - 3500e3).toISOString(), finished_at: new Date(Date.now() - 3480e3).toISOString() },
      { id: 11, status: "superseded", health: "ok", image: "app-demo01:41de77b", started_at: new Date(Date.now() - 7100e3).toISOString(), finished_at: new Date(Date.now() - 7080e3).toISOString() },
    ],
  },
  qa: {
    rounds: [
      { round: 2, status: "clean", findings: 0, summary: "All planned flows appear functional.", ts: new Date(Date.now() - 3400e3).toISOString() },
      { round: 1, status: "fixed", findings: 2, summary: "Empty list showed a raw error; delete button had no confirm.", ts: new Date(Date.now() - 7000e3).toISOString() },
    ],
  },
  backlog: {
    items: [
      { idx: 1, title: "Add a recipe with title + body", status: "done" },
      { idx: 2, title: "List recipes newest-first", status: "done" },
      { idx: 3, title: "Delete a recipe", status: "done" },
      { idx: 4, title: "Search box filtering by title", status: "done" },
      { idx: 5, title: "Mark a recipe as favourite", status: "todo" },
    ],
  },
  routes: {
    routes: [
      { method: "GET", path: "/api/health" },
      { method: "GET", path: "/api/recipes" },
      { method: "POST", path: "/api/recipes" },
      { method: "DELETE", path: "/api/recipes/:id" },
    ],
  },
  metrics: {
    containers: [
      { name: "app-demo01", cpu_pct: 0.8, mem_used: "48 MiB", mem_limit: "512 MiB", status: "running" },
      { name: "db-demo01", cpu_pct: 0.3, mem_used: "112 MiB", mem_limit: "1 GiB", status: "running" },
      { name: "redis-demo01", cpu_pct: 0.1, mem_used: "9 MiB", mem_limit: "256 MiB", status: "running" },
    ],
  },
  cache: {
    dbsize: 14,
    used_memory: "1.02 MiB",
    keys: ["search:chicken", "search:pasta", "recipes:list:v3", "session:9f2a…", "rate:127.0.0.1"],
  },
  domain: {
    url: "https://demo01.builderapps.osmike.com/",
    subdomain: "demo01.builderapps.osmike.com",
    cert_subject: "CN=*.builderapps.osmike.com",
    cert_expires: new Date(Date.now() + 61 * 864e5).toISOString(),
  },
  env: {
    env: [
      { key: "NODE_ENV", value: "production" },
      { key: "PORT", value: "3000" },
      { key: "APP_ID", value: "demo01" },
    ],
  },
};

const MOCK_LOG_LINES = [
  "app-demo01  | > app-demo01@ start",
  "app-demo01  | > node src/index.js",
  "db-demo01   | database system is ready to accept connections",
  "redis-demo01| Ready to accept connections tcp",
  "app-demo01  | migrate: 001_init.sql already applied",
  "app-demo01  | migrate: 002_favourites.sql already applied",
  "app-demo01  | listening on :3000",
  'app-demo01  | GET /api/health 200 3ms',
  'app-demo01  | GET /api/recipes 200 11ms',
  'app-demo01  | POST /api/recipes 200 18ms',
  'app-demo01  | GET / 200 2ms',
];

function seed() {
  store.set("demo01", {
    id: "demo01", title: "Recipe Box", status: "live", subdomain: "demo01",
    prompt: "A recipe box where I add recipes with a title and body, search them, and delete ones I don't cook.",
    url: "https://demo01.builderapps.osmike.com/",
    pipeline: "create", repo: "milkosten/app-demo01",
    created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
    updated_at: new Date(Date.now() - 3600e3).toISOString(),
    latest_run: { kind: "create", status: "done", current_step: PIPELINE_STEPS.length,
                  total_steps: PIPELINE_STEPS.length },
  });
  store.set("demo02", {
    id: "demo02", title: "URL Shortener", status: "building", subdomain: "demo02",
    prompt: "A URL shortener with click analytics and a dashboard of my links.",
    url: "https://demo02.builderapps.osmike.com/",
    pipeline: "create", repo: "milkosten/app-demo02",
    created_at: new Date(Date.now() - 1200e3).toISOString(),
    updated_at: new Date(Date.now() - 120e3).toISOString(),
    latest_run: { kind: "create", status: "running", current_step: 7, total_steps: PIPELINE_STEPS.length },
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
    return { ...listShape(p), repo: p.repo, prompt: p.prompt, latest_run: p.latest_run,
             messages: threads.get(id) || [] };
  },

  // --- durable thread + run polling -----------------------------------------
  async putMessages(id, messages) {
    await wait(40);
    threads.set(id, Array.isArray(messages) ? messages : []);
    return { stored: (messages || []).length };
  },
  async projectSteps(id) {
    await wait(80);
    const p = store.get(id);
    if (!p) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    const run = p.latest_run || {};
    return { status: run.status || "done", steps: run.steps || [] };
  },

  // --- workspace tabs --------------------------------------------------------
  async projectDocs() {
    await wait(140);
    return { docs: Object.entries(MOCK_DOCS).map(([name, d]) =>
      ({ name, title: d.title, size: d.markdown.length })) };
  },
  async projectDoc(_id, name) {
    await wait(120);
    const d = MOCK_DOCS[name];
    if (!d) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    return { name, markdown: d.markdown };
  },
  async projectFiles(_id, path) {
    await wait(130);
    return { entries: MOCK_TREE[path || ""] || [] };
  },
  async projectFile(_id, path) {
    await wait(120);
    const content = MOCK_FILES[path];
    if (content == null) {
      return { path, content: `// ${path}\n// (mock) this file exists in the repo but has no fixture body.\n`,
               size: 96, truncated: false };
    }
    return { path, content, size: content.length, truncated: path === "src/routes/recipes.js" };
  },
  async projectDatabase()    { await wait(150); return MOCK_TABS.database; },
  async projectSecrets(_id, reveal) {
    await wait(130);
    return { secrets: MOCK_TABS.secrets.secrets.map((s) =>
      reveal ? s : { key: s.key, masked: s.masked }) };
  },
  async projectLogs(_id, tail) {
    await wait(140);
    const stamp = new Date().toLocaleTimeString();
    return { lines: [...MOCK_LOG_LINES, `app-demo01  | GET /api/recipes 200 9ms  (refreshed ${stamp})`]
      .slice(-(Number(tail) || 200)) };
  },
  async projectCommits()     { await wait(160); return MOCK_TABS.commits; },
  async projectDeployments() { await wait(150); return MOCK_TABS.deployments; },
  async projectQa()          { await wait(150); return MOCK_TABS.qa; },
  async projectBacklog()     { await wait(140); return MOCK_TABS.backlog; },
  async projectRoutes()      { await wait(130); return MOCK_TABS.routes; },
  async projectMetrics()     { await wait(170); return MOCK_TABS.metrics; },
  async projectCache()       { await wait(130); return MOCK_TABS.cache; },
  async projectDomain()      { await wait(120); return MOCK_TABS.domain; },
  async projectEnv()         { await wait(120); return MOCK_TABS.env; },
  async lifecycle(id, action) {
    await wait(500);
    const p = store.get(id);
    if (!p) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    if (action === "destroy") { store.delete(id); threads.delete(id); return { destroyed: id }; }
    p.status = action === "stop" ? "stopped" : "live";
    p.updated_at = new Date().toISOString();
    return { status: p.status };
  },

  async createProjectStream({ prompt, title }, onEvent) {
    await wait(400);
    const id = rid();
    const t = title || (prompt ? prompt.slice(0, 40) : "Untitled app");
    const p = {
      id, title: t, status: "creating", subdomain: id, prompt,
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
