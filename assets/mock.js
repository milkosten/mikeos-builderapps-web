// mock.js — in-memory stub of builderapps-api, active only with ?mock=1 (or CFG.MOCK).
// Emits the FULL create-pipeline SSE event sequence (created -> step_start/step_done
// pairs interleaved with progress/repo/deploy) so the whole UI can be exercised offline
// with no backend and no auth. NEVER used in production.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => (Math.random().toString(36) + "000000").slice(2, 8);

// A call log for headless UI tests. WHICH endpoint a composer message reached is the
// whole point of @-mention routing ("@Developer …" must never touch the update
// pipeline), and that is only observable from outside if the mock records it.
globalThis.__BUILDERAPPS_MOCK_CALLS = [];
const record = (fn, args) => { globalThis.__BUILDERAPPS_MOCK_CALLS.push({ fn, args }); };

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

// Executed steps for a finished/partial run, so the mock exercises the same
// "replay history from the server" path the live API drives.
function mockSteps(upTo, { running = false } = {}) {
  return PIPELINE_STEPS.slice(0, upTo).map((name, idx) => ({
    idx,
    name: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    status: running && idx === upTo - 1 ? "running" : "done",
    log: running && idx === upTo - 1 ? "working…" : "ok",
    ts: new Date(Date.now() - (upTo - idx) * 60e3).toISOString(),
  }));
}

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
                  total_steps: PIPELINE_STEPS.length,
                  request: "A recipe box where I add recipes with a title and body.",
                  steps: mockSteps(PIPELINE_STEPS.length) },
  });
  store.set("demo02", {
    id: "demo02", title: "URL Shortener", status: "building", subdomain: "demo02",
    prompt: "A URL shortener with click analytics and a dashboard of my links.",
    url: "https://demo02.builderapps.osmike.com/",
    pipeline: "create", repo: "milkosten/app-demo02",
    created_at: new Date(Date.now() - 1200e3).toISOString(),
    updated_at: new Date(Date.now() - 120e3).toISOString(),
    latest_run: { kind: "create", status: "running", current_step: 7,
                  total_steps: PIPELINE_STEPS.length,
                  request: "A URL shortener with click analytics.",
                  steps: mockSteps(7, { running: true }) },
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

// ---- the shared workspace board (phase 32) --------------------------------
// Three authors on one board, on purpose: the build pipeline, an assistant and a human.
const _iso = (minsAgo) => new Date(Date.now() - minsAgo * 60e3).toISOString();
const MOCK_WORKSPACE = {
  items: [
    { id: 101, kind: "feature", title: "Create and list notes", body_md:
        "Planned by the build pipeline as feature 1 of 12.", status: "done",
      priority: "normal", assignee: "", created_by: "pipeline",
      created_by_kind: "pipeline", created_by_name: "build pipeline",
      created_at: _iso(320), updated_at: _iso(300), closed_at: _iso(300) },
    { id: 102, kind: "feature", title: "Share a note by link", body_md:
        "Planned by the build pipeline as feature 7 of 12.\n\n**Blocked:** failed twice "
        + "(health gate red after the share route); reverted to last good commit",
      status: "blocked", priority: "normal", assignee: "", created_by: "pipeline",
      created_by_kind: "pipeline", created_by_name: "build pipeline",
      created_at: _iso(320), updated_at: _iso(240) },
    { id: 103, kind: "feature", title: "Full-text search across notes", body_md:
        "Planned by the build pipeline as feature 9 of 12.", status: "in_progress",
      priority: "normal", assignee: "", created_by: "pipeline",
      created_by_kind: "pipeline", created_by_name: "build pipeline",
      created_at: _iso(320), updated_at: _iso(20) },
    { id: 104, kind: "bug", title: "Empty list renders no message at all", body_md:
        "`/notes` with zero rows renders a blank panel. Seen in a real browser with "
        + "`mikeweb check`; no JS errors, the list is simply empty.", status: "open",
      priority: "normal", assignee: "", created_by: "assistant:2",
      created_by_kind: "assistant", created_by_name: "Tester",
      created_at: _iso(45), updated_at: _iso(45) },
    { id: 105, kind: "kb", title: "Sessions are cookie-based, not JWT", body_md:
        "Decided when auth was added: a signed cookie, `SameSite=Lax`. Anything reading "
        + "`Authorization:` here is a mistake.", status: "open", priority: "normal",
      assignee: "", created_by: "assistant:1", created_by_kind: "assistant",
      created_by_name: "Product Owner", created_at: _iso(180), updated_at: _iso(180) },
    { id: 106, kind: "doc", title: "How the share link is meant to work", body_md:
        "A note gets an opaque 16-char slug; `/s/<slug>` renders read-only.",
      status: "open", priority: "normal", assignee: "", created_by: "user:mock",
      created_by_kind: "human", created_by_name: "you",
      created_at: _iso(120), updated_at: _iso(120) },
  ],
  counts: { by_kind: { feature: 3, bug: 1, kb: 1, doc: 1 },
            by_status: { done: 1, blocked: 1, in_progress: 1, open: 3 }, total: 6 },
  kinds: ["feature", "bug", "task", "testcase", "doc", "kb"],
  statuses: ["open", "in_progress", "blocked", "done", "rejected"],
};
const MOCK_WS_COMMENTS = {
  102: [{ id: 1, author: "assistant:3", author_kind: "assistant", author_name: "Developer",
          body_md: "The share route needs a migration the health gate never sees. I will "
                   + "split it into two deploys.", created_at: _iso(200) }],
  104: [{ id: 2, author: "assistant:3", author_kind: "assistant", author_name: "Developer",
          body_md: "Reproduced. The template renders `{{#each}}` with no `{{else}}`.",
          created_at: _iso(30) }],
};
const MOCK_WS_EVENTS = {
  101: [{ id: 1, actor: "pipeline", actor_kind: "pipeline", actor_name: "build pipeline",
          verb: "created", field: "kind", from_val: "", to_val: "feature", note:
          "Create and list notes", ts: _iso(320) },
        { id: 2, actor: "pipeline", actor_kind: "pipeline", actor_name: "build pipeline",
          verb: "status", field: "status", from_val: "open", to_val: "in_progress",
          note: "", ts: _iso(310) },
        { id: 3, actor: "pipeline", actor_kind: "pipeline", actor_name: "build pipeline",
          verb: "status", field: "status", from_val: "in_progress", to_val: "done",
          note: "built and deployed — src/routes/notes.js, views/notes.ejs", ts: _iso(300) }],
  102: [{ id: 4, actor: "pipeline", actor_kind: "pipeline", actor_name: "build pipeline",
          verb: "status", field: "status", from_val: "in_progress", to_val: "blocked",
          note: "failed twice (health gate red after the share route); reverted to last "
                + "good commit", ts: _iso(240) }],
  104: [{ id: 5, actor: "assistant:2", actor_kind: "assistant", actor_name: "Tester",
          verb: "created", field: "kind", from_val: "", to_val: "bug",
          note: "Empty list renders no message at all", ts: _iso(45) }],
};

// ---- phase 34: the discussion room ----------------------------------------
// Enough of a stand-in to drive the room offline: an opening draft with real chips, a canvas
// that moves as answers land, and "show me the vision" rendering inline. It is a SCRIPT, not
// a model — its only job is to let the UI (scroll policy, chips, canvas, persistence, Build
// it) be exercised with no backend.
const discussions = new Map();
let discussSeq = 0;

function mockCell(v, agreed = false) {
  return { value: v, agreed, source: agreed ? "decision" : "draft" };
}

export const mockApi = {
  async health() { return { status: "ok", database: "ok" }; },

  async startDiscussion(seed) {
    await wait(700);
    const id = "d" + (++discussSeq) + "mock";
    const disc = {
      id, seed, title: seed.slice(0, 60), status: "open", cost_usd: 0.004, turns: 1,
      canvas: {
        name: mockCell("Shelfie"),
        vision: mockCell("A quiet place for a small group to agree on what to read next and "
                         + "keep track of what they finished."),
        audience: mockCell("small in-person groups"),
        features: mockCell(["a shared shelf", "vote on the next book", "meeting notes"]),
        stack: mockCell("one account per group, data owned by the group"),
        out_of_scope: mockCell(["reading ebooks in the app"]),
        changelog: [],
      },
      messages: [
        { role: "user", text: seed },
        { role: "assistant",
          text: "Here's what I think you're building.\n\n**Shelfie** — a shared shelf for a "
              + "small group: everyone adds books, the group votes on what's next, and each "
              + "meeting gets a short note. I'd leave actual ebook reading out entirely.\n\n"
              + "Three things I need from you:",
          questions: [
            { q: "Who is this for?", options: ["just me", "a team", "the public"],
              recommended: "a team", why: "It decides whether accounts and sharing exist at all." },
            { q: "Where does the scope stop?",
              options: ["books only", "books + meetings", "books + meetings + reviews"],
              recommended: "books + meetings", why: "It sets the size of the first backlog." },
            { q: "Who owns the data?", options: ["each group", "one admin", "public read"],
              recommended: "each group", why: "It decides the auth model and the schema." },
          ] },
      ],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    discussions.set(id, disc);
    return JSON.parse(JSON.stringify(disc));
  },

  async listDiscussions() {
    await wait(80);
    return [...discussions.values()].map((d) => ({
      id: d.id, title: d.title, seed: d.seed, status: d.status, cost_usd: d.cost_usd,
      message_count: d.messages.length, created_at: d.created_at, updated_at: d.updated_at }));
  },

  async getDiscussion(id) {
    await wait(120);
    const d = discussions.get(id);
    if (!d) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    return JSON.parse(JSON.stringify(d));
  },

  async sayDiscussion(id, text) {
    await wait(900);
    const d = discussions.get(id);
    if (!d) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    d.messages.push({ role: "user", text });
    const reply = { role: "assistant" };
    if (/show|see|read|what/i.test(text) && /vision|plan|brief/i.test(text)) {
      reply.text = "Here it is as it stands:";
      reply.show = "vision";
      reply.shown = "## Shelfie\n\n" + d.canvas.vision.value
                  + "\n\n**Who it's for:** " + d.canvas.audience.value;
    } else {
      d.canvas.audience = mockCell(text.slice(0, 80), true);
      reply.text = "Got it — noted on the canvas. Anything you'd deliberately leave out?";
      reply.questions = [{ q: "Anything to rule out?", options: ["nothing yet", "no mobile app"],
                           recommended: "nothing yet", why: "Non-goals keep the backlog honest." }];
    }
    d.messages.push(reply);
    d.cost_usd = Number((d.cost_usd + 0.003).toFixed(4));
    d.turns += 1;
    d.updated_at = new Date().toISOString();
    return JSON.parse(JSON.stringify(d));
  },

  async discussionBrief(id) {
    await wait(120);
    const d = discussions.get(id);
    if (!d) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    return { id, title: d.canvas.name.value,
             brief: "Shelfie: " + d.canvas.vision.value + "\n\nWho it is for: "
                    + d.canvas.audience.value };
  },

  async deleteDiscussion(id) { discussions.delete(id); return { ok: true, deleted: id }; },

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

  // --- the shared WORKSPACE (phase 32) ---
  // Deliberately MIXED authorship: the pipeline's features (one of them blocked, with the
  // real reason), an assistant's bug, a human's note. `?mock=1` has to exercise the thing
  // this tab is actually for — showing who did what — not just a list of rows.
  async workspaceItems()     { await wait(140); return MOCK_WORKSPACE; },
  async workspaceItem(id, itemId) {
    await wait(110);
    const it = MOCK_WORKSPACE.items.find((i) => String(i.id) === String(itemId));
    if (!it) throw new Error("Not found");
    return { item: { ...it, comments: MOCK_WS_COMMENTS[it.id] || [],
                     events: MOCK_WS_EVENTS[it.id] || [], links: [] } };
  },
  async createWorkspaceItem(id, body) {
    await wait(220);
    const now = new Date().toISOString();
    const item = { id: 900 + MOCK_WORKSPACE.items.length, kind: body.kind || "task",
                   title: body.title, body_md: body.body_md || "",
                   status: body.status || "open", priority: "normal", assignee: "",
                   created_by: "user:mock", created_by_kind: "human", created_by_name: "you",
                   created_at: now, updated_at: now };
    MOCK_WORKSPACE.items.push(item);
    MOCK_WORKSPACE.counts.total++;
    MOCK_WORKSPACE.counts.by_kind[item.kind] = (MOCK_WORKSPACE.counts.by_kind[item.kind] || 0) + 1;
    return { ok: true, item };
  },
  async patchWorkspaceItem(id, itemId, body) {
    await wait(180);
    const it = MOCK_WORKSPACE.items.find((i) => String(i.id) === String(itemId));
    if (!it) throw new Error("Not found");
    const from = it.status;
    Object.assign(it, body, { updated_at: new Date().toISOString() });
    (MOCK_WS_EVENTS[it.id] = MOCK_WS_EVENTS[it.id] || []).push({
      id: Date.now(), actor: "user:mock", actor_kind: "human", actor_name: "you",
      verb: "status", field: "status", from_val: from, to_val: it.status, note: "",
      ts: new Date().toISOString() });
    return { ok: true, item: it };
  },
  async commentWorkspaceItem(id, itemId, body_md) {
    await wait(180);
    const c = { id: Date.now(), author: "user:mock", author_kind: "human",
                author_name: "you", body_md, created_at: new Date().toISOString() };
    (MOCK_WS_COMMENTS[itemId] = MOCK_WS_COMMENTS[itemId] || []).push(c);
    (MOCK_WS_EVENTS[itemId] = MOCK_WS_EVENTS[itemId] || []).push({
      id: Date.now() + 1, actor: "user:mock", actor_kind: "human", actor_name: "you",
      verb: "commented", field: "", from_val: "", to_val: "",
      note: String(body_md).slice(0, 120), ts: new Date().toISOString() });
    return { ok: true, comment: c };
  },

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
                     total_steps: PIPELINE_STEPS.length, request: prompt,
                     steps: mockSteps(PIPELINE_STEPS.length) };
  },

  async updateProjectStream(id, request, onEvent) {
    record("updateProjectStream", { id, request });
    const p = store.get(id);
    if (!p) { const e = new Error("not found"); e.name = "NotFoundError"; throw e; }
    const steps = ["Checkout latest", "Plan a minimal diff", "Apply the change",
                   "Rebuild the app", "Deploy the stack", "Runtime QA", "Finalize"];
    p.status = "building";
    await streamPipeline(p, onEvent, { steps });
    p.latest_run = { kind: "update", status: "done", current_step: steps.length,
                     total_steps: steps.length, request,
                     steps: steps.map((name, idx) => ({
                       idx, name: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
                       status: "done", log: "ok", ts: new Date().toISOString() })) };
  },

  // --- per-project AI assistants (phase 29) ---
  // Enough for the tab to render in ?mock=1; a NotFoundError would make it read as
  // "not shipped yet", which would be a lie once the backend is live.
  async assistantsCatalog() {
    await wait(120);
    return { roles_are_open_ended: true,
      limits: { min_interval_minutes: 5, max_interval_minutes: 10080, max_per_project: 12 },
      capabilities: [
        { id: "read_repo", label: "Read the repo", detail: "Clone and read the checkout.", safe_default: true },
        { id: "comment", label: "Comment", detail: "Post findings into the project thread.", safe_default: true },
        { id: "read_costs", label: "Read usage & cost", detail: "Read token/cost accounting.", safe_default: true },
        { id: "run_qa", label: "Run QA", detail: "Exercise the live app in a browser.", safe_default: true },
        { id: "edit_code", label: "Edit code", detail: "Write files in its own checkout.", safe_default: false },
        { id: "commit_push", label: "Commit & push", detail: "Push to the project repo.", safe_default: false },
        { id: "request_deploy", label: "Request a deploy", detail: "Ask the control plane to deploy.", safe_default: false },
      ],
      templates: [
        { key: "product_owner", role: "Product Owner", name: "Product Owner", optimises: "the product is worth using",
          description: "Reads the goals, judges the gap, proposes the next thing.",
          capabilities: ["read_repo", "comment", "read_costs"], interval_minutes: 120, soul_md: "# Who I am\nProduct owner." },
        { key: "developer", role: "Developer", name: "Developer", optimises: "it works and stays clean",
          description: "Reads the code, spots rot, proposes the fix.",
          capabilities: ["read_repo", "comment"], interval_minutes: 60, soul_md: "# Who I am\nEngineer." },
      ] };
  },
  // A REAL roster, because the composer's @-mention picker is driven by it and an empty
  // list makes the whole feature untestable offline. Deliberately shaped to exercise the
  // two matching hazards: a name with SPACES, and two names sharing a prefix
  // ("Dev" vs "Developer") where only longest-match gives the right answer.
  async assistants() {
    await wait(120);
    return { assistants: MOCK_ASSISTANTS.map((a) => ({ ...a })) };
  },
  async createAssistant(id, body) {
    await wait(200);
    return { id: 1, project_id: id, role: body.role || "Assistant", name: body.name || "Assistant",
             description: body.description || "", capabilities: body.capabilities || [],
             interval_minutes: body.interval_minutes || 60, status: body.start ? "active" : "paused" };
  },
  async assistant(id, aid) { await wait(120); return { id: aid, project_id: id, role: "Assistant", name: "Assistant", capabilities: [], interval_minutes: 60, status: "paused", soul_md: "", beats: [] }; },
  async patchAssistant(id, aid, body) { await wait(150); return { id: aid, project_id: id, ...body }; },
  async deleteAssistant() { await wait(150); return { ok: true }; },
  async assistantAction() { await wait(150); return { ok: true, status: "running" }; },
  async assistantBeats() { await wait(120); return { beats: [] }; },

  // An ADDRESSED beat ("@Developer add a search box"). Beating the same assistant twice
  // without letting the first finish reproduces the live 409, so the "already working"
  // path is reachable in ?mock=1 rather than only in production.
  async assistantBeat(id, aid, task) {
    record("assistantBeat", { id, aid, task: task || "" });
    await wait(150);
    if (mockBeating.has(aid)) {
      const e = new Error("This assistant already has a beat in flight.");
      e.status = 409;
      throw e;
    }
    mockBeating.add(aid);
    setTimeout(() => mockBeating.delete(aid), 20000);
    return { ok: true, beat_id: 900 + aid, status: "running" };
  },

  // The left-pane activity feed. The running beat REVEALS ONE MORE LINE per poll so
  // ?mock=1 exercises the real thing the live feed does — an array that only grows —
  // and therefore the anti-flicker signature and the 2.5s/15s cadence switch too.
  async assistantActivity() {
    await wait(90);
    mockActivityTick++;
    const shown = MOCK_RUNNING_ACTIVITY.slice(0, Math.min(mockActivityTick, MOCK_RUNNING_ACTIVITY.length));
    const finished = shown.length >= MOCK_RUNNING_ACTIVITY.length;
    return {
      beating: !finished,
      beats: [
        { beat_id: 11, assistant_id: 1, name: "Product Owner", role: "Product Owner",
          status: "done", trigger_kind: "schedule", cost_usd: 0.0071,
          thought: "Sign-up exists but there is no way back in.",
          ts: new Date(Date.now() - 26 * 60e3).toISOString(),
          finished_at: new Date(Date.now() - 25 * 60e3).toISOString(),
          activity: MOCK_DONE_ACTIVITY },
        { beat_id: 12, assistant_id: 2, name: "Developer", role: "Developer",
          status: finished ? "done" : "running", trigger_kind: "manual",
          cost_usd: finished ? 0.0134 : 0,
          thought: "The app has no accounts; I will add sessions.",
          ts: new Date(Date.now() - 3 * 60e3).toISOString(),
          finished_at: finished ? new Date().toISOString() : null,
          activity: shown },
      ],
    };
  },
};

let mockActivityTick = 0;
const MOCK_DONE_ACTIVITY = [
  { kind: "phase", icon: "📖", text: "reading the project's documents — read VISION.md, TECHNICAL-PLAN.md", ts: "15:41:02" },
  { kind: "text", icon: "🧠", text: "Sign-up exists but there is no way back in — login is the gap.",
    detail: "The vision promises returning users keep their lists, but there is no session handling at all.", ts: "15:41:19" },
  { kind: "result", icon: "✓", text: "filed backlog item \"add a login route\"", ok: true, ts: "15:41:26" },
];
const MOCK_RUNNING_ACTIVITY = [
  { kind: "phase", icon: "📖", text: "reading the project's documents — read VISION.md, TECHNICAL-PLAN.md", ts: "16:10:12" },
  { kind: "text", icon: "🧠", text: "The app has no accounts; I will add sessions.", ts: "16:10:30" },
  { kind: "tool", icon: "👀", text: "reading server.js", ts: "16:10:33" },
  { kind: "tool", icon: "✎", text: "editing server.js", ts: "16:10:51" },
  { kind: "tool", icon: "$", text: "rg -n 'app.get' server.js", ts: "16:10:55" },
  { kind: "result", icon: "✓", text: "committed 3f9a1c2 \"add sessions + login\"", ok: true, ts: "16:11:20" },
  { kind: "phase", icon: "🚀", text: "asking the control plane to build and health-gate this commit", ts: "16:11:21" },
  { kind: "result", icon: "🔴", text: "health gate FAILED — rolled back to the last good commit", ok: false,
    detail: "GET / returned 500: SessionStore is not a constructor", ts: "16:14:02" },
];

// The assistants GET .../assistants returns in ?mock=1. "Dev" exists ALONGSIDE
// "Developer" on purpose: a naive first-match parser resolves "@Developer add a search
// box" to "Dev" and hands the assistant the task "eloper add a search box".
const MOCK_ASSISTANTS = [
  { id: 1, role: "Product Owner", name: "Product Owner", status: "active",
    description: "Reads the goals, judges the gap, proposes the next thing.",
    capabilities: ["read_repo", "comment", "read_costs"], interval_minutes: 120,
    last_beat_at: new Date(Date.now() - 26 * 60e3).toISOString() },
  { id: 2, role: "Developer", name: "Developer", status: "active",
    description: "Reads the code, spots rot, ships the fix.",
    capabilities: ["read_repo", "edit_code", "commit_push"], interval_minutes: 60,
    last_beat_at: new Date(Date.now() - 3 * 60e3).toISOString() },
  { id: 3, role: "Developer", name: "Dev", status: "paused",
    description: "A second pair of hands, currently paused.",
    capabilities: ["read_repo"], interval_minutes: 240, last_beat_at: null },
  { id: 4, role: "Finance", name: "Expense management assistant", status: "active",
    description: "Watches spend and files the receipts.",
    capabilities: ["read_costs", "comment"], interval_minutes: 720,
    last_beat_at: new Date(Date.now() - 90 * 60e3).toISOString() },
];

// Assistants with a beat in flight — a second beat on one of these 409s, like the API.
const mockBeating = new Set();
