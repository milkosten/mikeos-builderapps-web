# mikeos-builderapps-web

The user-facing SPA at **`builderapps.osmike.com`** — describe an app, watch the AI
pipeline build it live, and see it deployed at `https://<id>.builderapps.osmike.com/`.

Vanilla ES-module SPA (no framework, no build step, no external CDNs/fonts). Copied
from and structurally identical to `mikeos-designer`, rebranded and re-pointed at the
builderapps control plane. OAuth 2.0 + PKCE against `account.osmike.com`.

## Files
- `index.html` — shell; loads `config.js` then `app.js`.
- `config.js` — deploy-time config (API base, issuer, client id, redirect). Edit in place.
- `app.js` — controller: chat/create, live pipeline narration, live preview iframe, project list.
- `assets/auth.js` — OAuth Authorization-Code + PKCE (S256); token in sessionStorage (`builderapps_*`).
- `assets/api.js` — `builderapps-api.osmike.com` client + SSE stream reader (fetch + Bearer).
- `assets/mock.js` — `?mock=1` stub emitting the full SSE pipeline sequence (offline UI dev).
- `assets/styles.css` — self-contained dark theme.

## The API contract (pinned)
- `GET  /api/health` → `{status,database}`
- `POST /api/projects {prompt, title?}` → **SSE**: `created` → `step_start`/`step_done` pairs,
  interleaved `progress`/`repo`/`deploy`, terminal `error`. Unknown event types tolerated.
- `GET  /api/projects` → `{projects:[{id,title,status,subdomain,pipeline,created_at,updated_at}]}`
- `GET  /api/projects/{id}` → project row + `latest_run` + `url`
- `POST /api/projects/{id}/update {request}` → SSE like create (404 → "changes coming soon")

## Run / dev
```bash
python3 -m http.server 8080     # http://localhost:8080/  (registered dev OAuth origin)
# offline UI: http://localhost:8080/?mock=1  (stubs the API + skips auth)
```

## Deploy
Served on 242 by a small `builderapps-web` Caddy container; the shared Caddy vhost
`builderapps.osmike.com { reverse_proxy builderapps-web:80 }`. See `DEPLOY.md`.
