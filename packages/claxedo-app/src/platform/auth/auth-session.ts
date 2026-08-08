// target layer: auth — the ONLY module allowed to consume platform/auth/auth-client's useAuth
// (composition roots may name it to BIND it here; nothing else may call it)
import type { Accessor } from "solid-js"
import type { useAuth } from "@/platform/auth/auth-client"

export type AuthSessionStatus = "loading" | "anonymous" | "signed"

type ExternalAuth = ReturnType<typeof useAuth>

export type AuthSession = {
  status: Accessor<AuthSessionStatus>
  session: ExternalAuth["session"]
  user: ExternalAuth["user"]
  signIn: ExternalAuth["signIn"]
  signOut: ExternalAuth["signOut"]
  signUp: ExternalAuth["signUp"]
  getToken: ExternalAuth["getToken"]
  refreshSession: ExternalAuth["refreshSession"]
  organization: Accessor<{ id?: string } | null | undefined>
}

/**
 * How a build hands this module an identity provider, without this module
 * importing one.
 *
 * The import above is `import type`. This file is still the ONLY module allowed
 * to reach `auth-client`'s `useAuth` — that invariant is unchanged — but it now
 * reaches it for its SHAPE only. The bundler erases type-only imports, so
 * `ExternalAuth` costs nothing at runtime and `@clerk/clerk-js` is no longer in
 * the import graph of anything that renders the shell.
 *
 * That matters because the shell's provider tree (`app/entry/app.tsx`) calls
 * `useAuthSession()` unconditionally, and BOTH products render that shell. A
 * static `import { useAuth }` therefore put the entire identity provider in the
 * local bundle — `local-entry-closure.guard.test.ts` measured that chain as
 * `local.tsx -> app/entry/app.tsx -> platform/auth/auth-session.ts ->
 * auth-client.ts`.
 *
 * Same seam as `platform/api/api.ts`'s `configureApiRuntime({ bearerToken })`,
 * and for the same reason: the hosted entry binds a real implementation and
 * `local.tsx` deliberately binds nothing. Deliberately NOT the
 * `workspace-startup.ts` shape, where an unbound port THROWS — waking a hosted
 * sandbox is an operation a local build cannot perform, so reaching it is a
 * wiring bug, whereas "nobody is signed in" is the local product's normal and
 * honest state.
 *
 * Spelled out member by member rather than as `() => ExternalAuth`, because
 * this names exactly what this module CONSUMES — the correct direction for a
 * port. `useAuth` satisfies it structurally, so the hosted binding is still
 * compiler-checked against the real provider, while `clerk` narrows to the one
 * member actually read off the Clerk instance (which also retires the `as` cast
 * `organization()` used to need). Everything else keeps its `ExternalAuth[...]`
 * type, because those types ARE the public `AuthSession` shape callers compile
 * against.
 */
export type ExternalAuthSource = () => {
  session: ExternalAuth["session"]
  user: ExternalAuth["user"]
  loading: Accessor<boolean>
  isSignedIn: Accessor<boolean>
  signIn: ExternalAuth["signIn"]
  signOut: ExternalAuth["signOut"]
  signUp: ExternalAuth["signUp"]
  getToken: ExternalAuth["getToken"]
  refreshSession: ExternalAuth["refreshSession"]
  clerk: { organization: { id?: string } | null | undefined }
}

let externalAuth: ExternalAuthSource | undefined

/**
 * Bind the identity provider. Pass `null` to unbind (tests; nothing in the app
 * unbinds at runtime).
 *
 * Must be called at module scope by the composition root, before render:
 * `useAuthSession()` runs inside the provider tree, and a binding installed
 * during render would leave the first read anonymous.
 */
export function configureAuthSession(source: ExternalAuthSource | null) {
  externalAuth = source ?? undefined
}

/**
 * The session a build with no identity provider genuinely has.
 *
 * This is not a stub pretending to be signed in, and not a stub pretending to
 * be loading: a local build IS anonymous, permanently and immediately, and
 * `status()` says so on the first read so nothing downstream waits for a
 * resolution that will never come. Every consumer already handles it —
 * `CloudAuthGate` renders (it only gates when `authEnabled`),
 * `PrincipalProvider` yields the `local` principal, `RailAccountMenu` shows
 * "Local workspace", `browserAccountPort.state()` reports `unsigned`.
 *
 * The reads and the idempotent operations answer; the two operations that
 * require a provider refuse:
 *
 *  - `session`/`user`/`organization` return null/undefined — there is no
 *    account, and that is a value, not a failure.
 *  - `getToken()` resolves `null`. It is a READ, it is reached from effects and
 *    from transports during render, and "there is no token" is exactly what a
 *    loopback-authenticated local build means. Throwing here would convert a
 *    normal state into a crash in code paths that already branch on null.
 *  - `signOut()` and `refreshSession()` resolve as no-ops. Signing out of
 *    nothing already leaves the user in the requested state, and an idempotent
 *    operation that refuses is just a broken Log out button.
 *  - `signIn()`/`signUp()` REJECT. Unlike the above these are explicit,
 *    user-initiated requests for something this build cannot do, they are only
 *    reachable from hosted-only surfaces (`/login`, `/cli-login`, the account
 *    menu's sign-in action, which is itself gated on `authEnabled`), and they
 *    are never called during render. Resolving silently would leave a button
 *    that reports success and does nothing — the failure shape
 *    `app-ports-wiring.guard.test.ts` exists to prevent. The rejection names
 *    the missing binding so it reads as the wiring bug it is.
 */
const NO_IDENTITY_PROVIDER =
  "this build bound no identity provider -- see configureAuthSession() in platform/auth/auth-session.ts"

const anonymousSession: AuthSession = {
  status: () => "anonymous",
  session: () => null,
  user: () => null,
  signIn: async () => {
    throw new Error(`signIn() is unavailable: ${NO_IDENTITY_PROVIDER}`)
  },
  signOut: async () => undefined,
  signUp: async () => {
    throw new Error(`signUp() is unavailable: ${NO_IDENTITY_PROVIDER}`)
  },
  getToken: async () => null,
  refreshSession: async () => undefined,
  organization: () => undefined,
}

export function useAuthSession(): AuthSession {
  if (!externalAuth) return anonymousSession
  const auth = externalAuth()
  return {
    status: () => auth.loading() ? "loading" : auth.isSignedIn() ? "signed" : "anonymous",
    session: auth.session,
    user: auth.user,
    signIn: auth.signIn,
    signOut: auth.signOut,
    signUp: auth.signUp,
    getToken: auth.getToken,
    refreshSession: auth.refreshSession,
    organization: () => auth.clerk.organization,
  }
}
