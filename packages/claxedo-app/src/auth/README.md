# auth

Owns: the account, as one port with two bindings: the browser's own sign-in session with the identity provider (Better Auth), and on the desktop Electron main's account, reached over the preload's `api.account` bridge. Also the full-screen auth routes and the origins they talk to. It does not own who may do what; that is `src/access/`.

## Concepts

- `AccountBinding` (`binding.ts`): what `createAuth` is built over. `open()` returns an `AccountSession`: the user, whether sign-in is in flight, why it is unavailable, whether a signed identity is still being looked up, whether sign-in is offered, sign-in, sign-up, sign-out, refresh, and `controlPlane`, how the app reaches the account's control plane. The build picks one binding (`vite.account-binding.ts`, `VITE_CLAXEDO_AUTH_ADAPTER`), imported as `#account-binding`:
  - `better-auth` (`better-auth-binding.ts` over `browser-binding.ts`): the web. `controlPlane` is `cookie`: the server the app talks to is the control plane, and its Better Auth session cookie authenticates requests. `serverAccess` (`app.tsx`) turns it into cookie requests and the browser account while signed in, and into no account access signed out. Sign-in is offered when the server issues sessions and the adapter is available.
  - `desktop` (`electron-binding.ts` over `desktop-binding.ts` and `desktop-bridge.ts`): the Electron renderer. Main owns the credential and the OAuth flow in the system browser; the renderer holds no token, URL or method. `controlPlane` is `port`: `run(operation, input)` names one operation of `@claxedo/account-contract`'s closed set and main decides the request. Sign-in is offered when the build is signed-capable (`VITE_CLAXEDO_HOSTED_ACTIVATION=true`, v1's hosted activation flag). The renderer starts `pending` until main answers, adopts every state main pushes (`claxedo.account.stateChanged`), and drops an invoke answer that a push overtook. A rejected operation re-reads main's state before the caller sees the failure. The module throws at load when the preload exposes no complete bridge.

- `BrowserAuthAdapter` (`browser-auth.ts`): the provider-neutral contract. `better-auth-adapter.ts` is the one implementation: it composes `better-auth-client.ts` (the library's client, its results and the callback URL), `better-auth-session.ts` (the signals, the live descriptor, the session and `initialize`) and `better-auth-actions.ts` (sign-in, sign-up and sign-out). The web's binding (`better-auth-binding.ts`) builds it.
- `BrowserAuthDescriptor`: the live deployment's declaration, read from `GET /api/claxedo/auth/descriptor` and validated against the canonical `account-contract/auth` types with the browser binding's schema; a mismatch leaves the app signed out with the reason, never a startup failure.
- `AuthUser`: the sanitized identity (id, name, email, image). The browser binding exposes no token; the HTTP-only Better Auth cookie stays with the browser. Desktop main owns its credential.
- The auth routes answer JSON, and a proxy's HTML error page has no fields to read, so `authResponseBody` reads a body only when the response says it is JSON (`better-auth-error.ts`).
- Origins (`origins.ts`): `apiOrigin()` is `VITE_CLAXEDO_SERVER_URL` or the page origin; `appOrigin()` is the page origin; `serverIssuesSessions()` is `VITE_CLAXEDO_ISSUES_SESSIONS !== "0"`.

- Invitation continuation (`login-continuation.ts`): sign-in or sign-up retains `/invitations#<token>`, then calls the server's typed `acceptOrgInvitation` action. The server owns email matching, expiry, revocation, single use and membership; the app owns only the authentication and acceptance screen.

## Machine

`AuthState`: `signedOut(reason?)` → `signingIn` → `signedIn(user)`; `signedIn` → `expired` when a refresh is refused. Events: `started`, `settled(user, reason?)`, `signedOut`, `expired`. The session's `loading`, `user` and `unavailable` signals feed `settled`; nothing else decides the state. Main's desktop states map onto it: `pending` → `signingIn`, `signed` → `signedIn` (with `identityResolving` while its name is still being looked up), `unsigned` → `signedOut`, `unavailable` → `signedOut` with main's detail as the reason. A state main never sends decodes as unavailable, never as signed.

`InvitationState` (`model.ts`): `idle` → `authenticating` → `accepting` → `joined(result)` or `failed(failure)`. Pending email verification returns to `idle`. A refused acceptance can be retried explicitly; a successful acceptance is retained so the screen sends no second consume request.

## Routes

`authRoutes` (`routes.ts`): `/login`, `/device` (device grant approval, where the CLI's sign-in is approved), `/oauth/consent` (MCP scope consent), `/invitations#<token>` (sign-up/sign-in and invitation acceptance). The shell registers them outside the app shell.

## Invariants

- The consent page only narrows scopes; `claxedo:admin` is offered only to clients this deployment registered.
- Signing out clears every `claxedo:` preference except the last user id; a different user signing in clears them too.
- No test bypass exists in this domain; flows sign in against the real Worker with the scripted OAuth provider.

- The desktop renderer never holds the account's credential: its binding has no token, and every control-plane call crosses main by operation name.

## Flows

21 (sign-in on a machine used unsigned: the desktop signs in through main, the account card, sign-out, and a cloud workspace from the account catalog), 23 (team sharing, two browsers), 36 (access).

Invitation acceptance and email verification need the real D1 Worker with a deployment-owned email sender. The focused continuation tests cover the shared accept action; browser acceptance and flow 33 phone layout remain acceptance checks for the integration runner.
