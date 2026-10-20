# Request authentication

How the hosted control plane learns who a signed request comes from. Who may then do what is the D1 authority's (`authority/adapters/d1/`), and it reads that on every request.

## A cookie-signed request, verified live

The browser sends Better Auth's `__Secure-claxedo.session_token` cookie. The hosted core asks `options.authentication.authenticate(request)`, composed in `better-auth-d1-compose.ts` as:

1. `withBrowserPrincipalCache` (`browser-principal-cache.ts`), described below, which hands a request it cannot answer to
2. `createControlPlaneAuthenticationAdapter` (`@claxedo/server-core/platform/auth/authentication`): refuses a cookie sent beside an `Authorization` header and a cookie from an untrusted origin, then calls
3. `createBetterAuthD1RequestAuthenticationAdapter.verify` (`better-auth-d1-request-authentication.ts`):
   - round 1, `AUTH_DB`: Better Auth's `getSession` with `disableCookieCache` and `disableRefresh`, the session row by token joined to its user. A missing or expired session is a 401.
   - round 2, beside each other: the sign-in evidence row bound to that session (`better-auth-d1-authentication-evidence.ts`, `AUTH_DB`), which says how the person signed in, and the identity mapping (`D1ApplicationIdentityAuthority.ensureApplicationIdentity`, `CONTROL_PLANE_DB`), which names the application user and human actor and says whether they are active.
4. The principal: user, actor, Better Auth subject and session, sign-in methods and assurance, and the browser client bound to the request's origin.

Then the route runs, and its own first round carries `requireHuman` (`access-context.ts`): the identity is still linked to that user and actor and both are active. Every authorization rule (organization membership and role, workspace and session read authority, shares) is a statement of the route.

## The principal cache

A request whose session cookie was verified live within the last 60 s is admitted on that verification's principal without rounds 1 and 2. The principal travels in the browser's own cookie, `__Host-claxedo.principal` (HTTP-only, `Secure`, `SameSite=Lax`, host-only, `Max-Age=60`), so it reaches whichever isolate and machine answers; an isolate-memory cache would miss on every cold isolate and on every warm one that did not serve the last request, which is most requests after a pause ([worker-cold-starts-2026-10-19](../../../../../docs/perf/worker-cold-starts-2026-10-19/README.md)).

- What it holds: the principal's identity fields above, the deployment id and auth configuration version, a SHA-256 of the session cookie it was issued beside, and its expiry. It holds no authorization: membership, roles, shares and Runtime Access Tokens are read live by the route, and so is `requireHuman`.
- Signing: HMAC-SHA-256 under a key derived by HKDF from `BETTER_AUTH_SECRET` with its own label, so no Better Auth cookie verifies as a cache or the reverse.
- Issued: on the answer to a cookie request the live path verified (`responseCookies`, appended by `authenticationResponseCookies` in the hosted core). An admitted request issues nothing, so the cache never outlives the verification it came from.
- Used only for a request that carries exactly one session cookie, no `Authorization` header, and a trusted origin. A cache whose signature fails, that names another deployment, configuration or session cookie, or that has expired is ignored and the request is verified live, whose answer carries a fresh cache.
- Cleared: Better Auth's answers that set or clear the session cookie (sign-in, sign-out, a session refresh) also expire the cache (`retireBrowserPrincipalCache`).
- Not cached: the bearer transport (the desktop's and CLI's access tokens, introspected on every request), MCP access tokens, `verifyIdentity` (the explicit enrollment flows), and Better Auth's own routes, including `get-session`, OAuth authorize and consent and device approval, which read the session row every time.

Better Auth's own `session.cookieCache` is left off: it caches the session row only, so the evidence and identity round would remain, and once enabled every Better Auth route behind `sessionMiddleware` reads the cached session, among them the OAuth provider's authorize and consent, so a revoked browser session could still approve a native client's 30-day refresh token for the cache's lifetime.

### Worst-case lag

| change | effect on a browser holding a cache |
|---|---|
| sign-out in this browser | immediate: both cookies are cleared, and the cache alone is not a credential |
| sign-in as someone else in this browser | immediate: the new session cookie does not match the cache's |
| session revoked elsewhere (another device, "revoke all", an administrator), or a stolen copy of both cookies used after sign-out | admitted for at most 60 s after the last live verification, then 401 |
| session expiry | at most 60 s past `expiresAt` |
| account suspended or deleted, identity unlinked | immediate on every route that reads the authority (`requireHuman`) |
| membership, role, share or workspace access removed | immediate: authorization is never cached |
| `BETTER_AUTH_SECRET`, deployment id or auth configuration changed | immediate: the cache stops verifying |

On the web a 401 makes the app re-read `get-session`, which Better Auth answers from the session row, so a revoked session signs the reader out on the first refused request.
