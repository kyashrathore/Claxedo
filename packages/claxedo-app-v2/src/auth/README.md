# auth

Owns: the browser sign-in session with the identity provider (Better Auth), the four full-screen auth routes, and the origins those routes talk to. It does not own who may do what; that is `src/access/`.

## Concepts

- `BrowserAuthAdapter` (`browser-auth.ts`): the provider-neutral contract. `better-auth-adapter.ts` is the one implementation, selected at build time by `vite.browser-auth.ts` (`VITE_CLAXEDO_AUTH_ADAPTER=better-auth`) and imported as `#browser-auth-adapter`.
- `BrowserAuthDescriptor`: the live deployment's declaration, read from `GET /api/claxedo/auth/descriptor` and checked field by field against this build; a mismatch leaves the app signed out with the reason, never a startup failure.
- `AuthUser`: the sanitized identity (id, name, email, image). No token ever reaches a component; `Auth.token()` exists for the CLI exchange only.
- Origins (`origins.ts`): `apiOrigin()` is `VITE_CLAXEDO_SERVER_URL` or the page origin; `appOrigin()` is the page origin; `serverIssuesSessions()` is `VITE_CLAXEDO_ISSUES_SESSIONS !== "0"`.

## Machine

`AuthState`: `signedOut(reason?)` → `signingIn` → `signedIn(user)`; `signedIn` → `expired` when a refresh is refused. Events: `started`, `settled(user, reason?)`, `signedOut`, `expired`. The adapter's `loading`, `user` and `unavailable` signals feed `settled`; nothing else decides the state.

## Routes

`authRoutes` (`routes.ts`): `/login`, `/device` (device grant approval), `/oauth/consent` (MCP scope consent), `/cli-login` (CLI token handoff, loopback callback only). The shell registers them outside the app shell.

## Invariants

- The CLI token is posted only to an `http:` loopback callback (`localCallback`).
- The consent page only narrows scopes; `claxedo:admin` is offered only to clients this deployment registered.
- Signing out clears every `claxedo:` preference except the last user id; a different user signing in clears them too.
- No test bypass exists in this domain; flows sign in against the real Worker with the scripted OAuth provider.

## Flows

21 (sign-in on a machine used unsigned), 23 (team sharing, two browsers), 36 (access).
