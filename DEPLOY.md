# Deploying mikeos-builderapps-web (the SPA at builderapps.osmike.com)

Static SPA — plain HTML/CSS/ES-module JS, no build step, no framework, no external CDNs.
Served on **242** by a tiny `builderapps-web` Caddy container; the **shared** Caddy
(`deploy-caddy-1`) reverse-proxies `builderapps.osmike.com` to it.

## 1. Put the checkout + compose on 242
```bash
# on 242 (root@91.98.177.242, key ~/.ssh/mikeos_media)
git clone git@github.com:milkosten/mikeos-builderapps-web.git /opt/mikeos-builderapps-web
cp /opt/mikeos-builderapps-web/web-Caddyfile /opt/mikeos-builderapps-web/web-Caddyfile   # already in repo
docker compose -f /opt/mikeos-builderapps-web/docker-compose.yml up -d
```
The container mounts the repo dir read-only at `/srv/spa` and serves it. To ship an
update: `git pull` in `/opt/mikeos-builderapps-web` (no container restart needed — the
files are read live).

## 2. Shared Caddy vhost (append ONE block; do NOT touch the other ~60 vhosts)
The shared Caddyfile is `/opt/mikephotos/deploy/Caddyfile`. **Back it up first**, append
the vhost, validate, and only reload if valid:
```bash
cp /opt/mikephotos/deploy/Caddyfile /opt/mikephotos/deploy/Caddyfile.bak.$(date +%s)
cat >> /opt/mikephotos/deploy/Caddyfile <<'EOF'

builderapps.osmike.com {
	reverse_proxy builderapps-web:80
}
EOF
docker exec deploy-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec deploy-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
The `*.builderapps.osmike.com` wildcard, `builderapps-api`, and `gitea` vhosts must stay
intact — only the bare `builderapps.osmike.com` UI host is added here.

DNS `builderapps.osmike.com` → 242 already exists.

## 3. config.js — PRODUCTION values (already the committed defaults)
```js
window.BUILDERAPPS_CONFIG = {
  API_BASE:     "https://builderapps-api.osmike.com",
  ISSUER:       "https://account.osmike.com",
  CLIENT_ID:    "builderapps-web",
  REDIRECT_URI: "https://builderapps.osmike.com/auth/callback",
  SCOPE:        "openid profile email",
  AUDIENCE:     "builderapps",
  MOCK:         false
};
```

## 4. OAuth client at account.osmike.com
Public PKCE client `builderapps-web` (`token_endpoint_auth_method=none`, S256 required),
redirect URIs `https://builderapps.osmike.com/auth/callback` and (dev)
`http://localhost:8080/auth/callback`. The AS token endpoint must send CORS for
`https://builderapps.osmike.com` (the code→token exchange happens in the browser).
`builderapps-api` must allow CORS from `https://builderapps.osmike.com` on `/api/*`.

## 5. Local dev / mock
```bash
python3 -m http.server 8080          # real OAuth via the registered localhost redirect
# or offline:  http://localhost:8080/?mock=1
```
