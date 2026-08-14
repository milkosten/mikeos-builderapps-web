// config.js — deploy-time configuration for the mikeos-builderapps SPA.
// Loaded as a plain <script> before app.js. Adjust these values for prod/staging
// WITHOUT rebuilding anything. All values are PUBLIC (this is a browser client) —
// PKCE means no client secret ever lives here.
window.BUILDERAPPS_CONFIG = {
  // The builderapps control plane (resource server). Every /api/* call goes here.
  API_BASE: "https://builderapps-api.osmike.com",

  // account.osmike.com — the OAuth 2.0 / OIDC Authorization Server.
  ISSUER: "https://account.osmike.com",

  // OAuth public client id registered at account.osmike.com for this SPA.
  // (Registered live in the identity DB as a public PKCE client, no secret.)
  CLIENT_ID: "builderapps-web",

  // Must EXACTLY match a redirect_uri registered on the client at the issuer.
  // Convention across MikeOS web apps is /auth/callback. auth.js will automatically
  // use `<origin>/auth/callback` when the page is served from http://localhost:8080
  // so the SAME config works for both prod and dev without editing.
  REDIRECT_URI: "https://builderapps.osmike.com/auth/callback",

  // Requested scopes. Registered scopes for this client are the OIDC basics.
  SCOPE: "openid profile email",

  // Audience passed through to the AS (harmless if the AS ignores it).
  AUDIENCE: "builderapps",

  // Dev-only: set true (or append ?mock=1 to the URL) to stub the API + skip auth
  // so the full UI can be exercised with no backend deployed. Never true in prod.
  MOCK: false
};
