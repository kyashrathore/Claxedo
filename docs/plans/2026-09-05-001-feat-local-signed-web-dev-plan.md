# Local signed web development

**Status:** in progress · 2026-09-05
**Owner:** codex/refactor-agent-plugins branch

## Problem

A developer cannot run the signed web app against a local server. The pieces exist in
isolation: `CLAXEDO_EMBEDDED_AUTH=1` boots an embedded Better Auth issuer and switches
the self-hosted Node server to signed mode (bearer sessions work, the two-user e2e proves
it), the web app has a cookie-transport Better Auth adapter, and the local Agent Plugins
module runs inside the desktop's server. They are not composed together:

1. The self-hosted server serves no `/api/claxedo/auth/descriptor`; only the hosted shell
   does. The web app's first request is that descriptor.
2. The self-hosted server recognises bearer sessions only. A browser session lives in a
   cookie, and cookie-authenticated mutations need the origin and content-type guard the
   hosted worker applies (`browserAuthHttpSecurity`).
3. The self-hosted server does not mount the local Agent Plugins module; the desktop does.
4. The web client refuses non-HTTPS origins for sign-in (`exactOrigin`, `Secure` cookie)
   and classifies any localhost server as `loopback`, which it defines as "has no accounts".
5. The signed marketplace assumes a catalog with `projects` and refuses a mutation without
   one ("Select at least one project"); a self-hosted box has no project list.

## Design

One HTTPS origin fronts both halves: the Vite dev server serves the app over TLS and
proxies `/api`, `/global` and the rest to the self-hosted server over loopback HTTP (the
proxy list already exists). The API origin equals the app origin, so the browser holds one
`Secure` cookie for `https://localhost:<port>` and never crosses origins. The self-hosted
server mints that cookie because the embedded issuer's `baseURL` is the HTTPS origin
(`BETTER_AUTH_URL`) and Better Auth derives `useSecureCookies` from it.

- **Descriptor.** `self-hosted-node/embedded-browser-auth.ts` builds the Better Auth
  descriptor for the embedded issuer from the same contract the hosted worker uses
  (`adapter: better-auth`, cookie transport, `reject-cookie-and-authorization`,
  `__Secure-claxedo.session_token`, methods `["email-password"]`, trusted origin = the
  public origin, `resource` = the public origin, one-year expiry computed per request).
  Mounted at `GET /api/claxedo/auth/descriptor` when embedded auth is on. The embedded
  issuer sets `advanced.cookiePrefix: "claxedo"` and secure cookie attributes like the
  hosted issuer so the cookie name and attributes match the descriptor.
- **Cookie transport.** The embedded issuer's bearer plugin accepts the same signed
  session token the cookie carries. A middleware mounted only when embedded auth is on
  reads the exact session cookie on requests that carry no `Authorization` header and
  presents it as the bearer credential, after `browserAuthHttpSecurity(descriptor.browser)`
  has enforced the origin and JSON content-type rules for cookie-authenticated mutations.
  Every signed self-hosted route keeps its one bearer verifier.
- **Agent Plugins.** `startSelfHostedServer` composes `createLocalAgentPluginsComposition`
  when `CLAXEDO_AGENT_PLUGINS=1` and passes its `routeContributions`, exactly as the
  desktop's server entry does.
- **Client.** A server that reports auth enabled is `signed-web`, not `loopback`, even on
  localhost; the HTTPS origin check stays (it is what makes the `Secure` cookie valid).
  A signed catalog without a `projects` list targets `all-projects`.
- **Dev TLS.** `script/dev-tls.ts` writes a self-signed localhost certificate under
  `.artifacts/dev-tls/` with `openssl`; `vite.cloud.config.ts` enables `server.https`
  from it when `CLAXEDO_DEV_TLS=1`. Launch entries `claxedo-server-embedded-auth` and
  `claxedo-app-signed-local` run the pair.

## Definition of done

- [x] `GET /api/claxedo/auth/descriptor` on the self-hosted server (embedded auth on)
      answers a descriptor the web client's `parseDescriptor` accepts; unit test
      (`embedded-browser-auth.test.ts`).
- [x] A cookie session reaches a signed self-hosted route as the bearer credential; a
      cookie-authenticated POST without JSON content type is refused 415 and a cross-site
      one 403; unit tests, and proven live through the HTTPS proxy origin.
- [x] `/api/claxedo/plugins` answers on the self-hosted server with `CLAXEDO_AGENT_PLUGINS=1`.
- [x] Web client: localhost server with auth enabled is `signed-web` (`server-transport.test.ts`);
      signed catalog without projects mutates with `all-projects` (proven live: activation 200,
      revision 0 → 1).
- [ ] Live in a browser: `https://localhost:4449` — sign in with email + password, marketplace
      renders, Enable and Disable round-trip, sign out. The in-app browser pane refuses the
      self-signed certificate outright; this needs a real Chrome click-through (owner).

## Progress log

- 2026-09-05: gaps enumerated from the code (above); plan written.
- 2026-09-05 00:45: slice landed (`f57cd5ca46`). Launch entries `claxedo-server-embedded-auth`
  (:2597, `BETTER_AUTH_URL=https://localhost:4449`) and `claxedo-app-signed-local` (:4449,
  `CLAXEDO_DEV_TLS=1`, `CLAXEDO_DEV_PROXY_TARGET=http://127.0.0.1:2597`,
  `VITE_CLAXEDO_SERVER_URL=https://localhost:4449`) run the pair. Fixture user created through
  the local sign-up API for the curl proofs. Open: the local plugin routes answer the catalog
  without a session even in signed mode (machine-local semantics); decide whether a signed box
  should gate them.
- 2026-09-05 00:50: owner signed in on https://localhost:4449 in Chrome; New Project showed "No folders
  found" because the cookie bridge was mounted on `/api/*` only while the folder picker reads the
  engine-compat `/file` and `/path` routes, which verify a bearer in signed mode. Bridge and guard now
  mount on every route; proven: `/file` and `/path` through the proxy answer 401 without the cookie and
  200 with it.

