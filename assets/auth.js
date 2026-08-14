// auth.js — OAuth 2.0 Authorization Code + PKCE (S256) against account.osmike.com.
// Public client, NO client secret in the browser. Access token in sessionStorage.
// The token exchange goes DIRECTLY to the issuer's token endpoint (public client),
// so the issuer must allow CORS from https://builderapps.osmike.com (see DEPLOY.md).

const CFG = window.BUILDERAPPS_CONFIG;

// The redirect_uri MUST byte-match one registered on the client. The prod value
// lives in config; when served from the registered localhost:8080 dev origin we
// use that origin's /auth/callback so the SAME config drives both environments.
function effectiveRedirectUri() {
  if (location.origin === "http://localhost:8080" || location.origin === "http://127.0.0.1:8080") {
    return location.origin + "/auth/callback";
  }
  return CFG.REDIRECT_URI;
}

const KEY_TOKEN    = "builderapps_access_token";
const KEY_EXP      = "builderapps_token_exp";      // epoch ms
const KEY_VERIFIER = "builderapps_pkce_verifier";
const KEY_STATE    = "builderapps_oauth_state";

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randB64(n) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256b64(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return b64url(digest);
}

// Decode a JWT payload without verifying (verification is the resource server's job;
// we only read `exp` to know when to refresh, and `email`/`name` for display).
function decodeJwt(token) {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch { return null; }
}

export const auth = {
  token() {
    const t = sessionStorage.getItem(KEY_TOKEN);
    if (!t) return null;
    const exp = Number(sessionStorage.getItem(KEY_EXP) || 0);
    if (exp && Date.now() > exp - 15000) { this.clear(); return null; }  // treat as expired
    return t;
  },

  isAuthed() { return !!this.token(); },

  user() {
    const t = this.token();
    if (!t) return null;
    const c = decodeJwt(t) || {};
    return { sub: c.sub, email: c.email, name: c.name || c.preferred_username || c.email || "MikeOS user" };
  },

  clear() {
    sessionStorage.removeItem(KEY_TOKEN);
    sessionStorage.removeItem(KEY_EXP);
  },

  // Kick off the redirect to account.osmike.com/oauth/authorize.
  async login() {
    const verifier  = randB64(32);
    const state     = randB64(16);
    const challenge = await sha256b64(verifier);
    sessionStorage.setItem(KEY_VERIFIER, verifier);
    sessionStorage.setItem(KEY_STATE, state);

    const u = new URL(CFG.ISSUER + "/oauth/authorize");
    const params = {
      response_type: "code",
      client_id: CFG.CLIENT_ID,
      redirect_uri: effectiveRedirectUri(),
      scope: CFG.SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    if (CFG.AUDIENCE) params.audience = CFG.AUDIENCE;   // harmless if the AS ignores it
    u.search = new URLSearchParams(params);
    location.assign(u.toString());
  },

  logout() {
    this.clear();
    location.assign("/");
  },

  // Handle the /callback redirect: verify state, exchange code -> token.
  // Returns true if a token was obtained, false otherwise (caller then shows login).
  async handleCallback() {
    const p = new URLSearchParams(location.search);
    const code  = p.get("code");
    const state = p.get("state");
    const err   = p.get("error");
    const verifier = sessionStorage.getItem(KEY_VERIFIER);
    const savedState = sessionStorage.getItem(KEY_STATE);
    sessionStorage.removeItem(KEY_VERIFIER);
    sessionStorage.removeItem(KEY_STATE);

    if (err) { console.warn("OAuth error:", err, p.get("error_description")); return false; }
    if (!code || !verifier || !state || state !== savedState) return false;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: effectiveRedirectUri(),
      client_id: CFG.CLIENT_ID,
      code_verifier: verifier,
    });

    let tok;
    try {
      const r = await fetch(CFG.ISSUER + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body,
      });
      if (!r.ok) { console.warn("token exchange failed", r.status, await r.text().catch(()=>"" )); return false; }
      tok = await r.json();
    } catch (e) {
      console.warn("token exchange network error", e);
      return false;
    }

    if (!tok.access_token) return false;
    sessionStorage.setItem(KEY_TOKEN, tok.access_token);
    // Prefer explicit expires_in; fall back to the JWT exp claim; else assume 15 min.
    let expMs;
    if (tok.expires_in) expMs = Date.now() + Number(tok.expires_in) * 1000;
    else {
      const c = decodeJwt(tok.access_token);
      expMs = c && c.exp ? c.exp * 1000 : Date.now() + 15 * 60 * 1000;
    }
    sessionStorage.setItem(KEY_EXP, String(expMs));
    return true;
  },
};
