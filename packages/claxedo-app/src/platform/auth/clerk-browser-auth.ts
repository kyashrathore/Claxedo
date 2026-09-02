import { createEffect, createSignal, onCleanup } from "solid-js"
import {
  assertBrowserAuthDescriptorBinding,
  browserAuthUnavailable,
  browserAuthUnavailableReason,
  loadBrowserAuthDescriptor,
  type BrowserAuthAdapter,
  type BrowserAuthDeployment,
  type BrowserAuthDescriptor,
  type BrowserAuthSignInOptions,
  type BrowserAuthSignUpOptions,
} from "./browser-auth"
import { clearPersistedAuthState, recordBrowserAuthIdentity } from "./browser-auth-persistence"
import type { AuthDisplayUser } from "./auth-display"
import {
  browserAuthTestSignedOut,
  markBrowserAuthTestSignedOut,
  recordBrowserAuthTestSignIn,
  testBrowserAuth,
} from "./browser-auth-test-bypass"

/**
 * Clerk client instance for Claxedo cloud mode.
 * Lazily initialized only when auth is enabled.
 */
const clerkPubKey = envString(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) ?? ""

type ClerkTokenOptions = {
  template?: "convex"
  skipCache?: boolean
}

type ClerkInstance = InstanceType<typeof import("@clerk/clerk-js/headless").Clerk>
type ClerkSession = ClerkInstance["session"]
type ClerkResources = Parameters<ClerkInstance["addListener"]>[0] extends (resources: infer Resources) => unknown
  ? Resources
  : never
type ClerkSignInRedirectOptions = Parameters<ClerkInstance["redirectToSignIn"]>[0]
type ClerkSignUpRedirectOptions = Parameters<ClerkInstance["redirectToSignUp"]>[0]

// Lazy Clerk instance - only created when needed
let clerkInstance: ClerkInstance | null = null
let clerkLoadPromise: Promise<void> | null = null

/**
 * Extract a stable user id from an unknown Clerk user resource.
 */
function userIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const id = (value as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * On an auth-identity change, purge stale persisted state from a PREVIOUS
 * account so it does not bleed into the next account on the same browser.
 *
 * - First sign-in (no prior id stored): records the id, purges nothing.
 * - Same id as last seen: no-op.
 * - Different non-null id: purge `opencode.*` state, then record the new id.
 * - Sign-out (null user): leaves lastUserId untouched (sign-out's own clear()
 *   handles purging) so the next sign-in can still compare against it.
 */
function handleAuthIdentityChange(nextUser: unknown) {
  const nextId = userIdOf(nextUser)
  recordBrowserAuthIdentity(nextId)
}

// SolidJS Signals for auth state
const [authResources, setAuthResources] = createSignal<{
  session: ClerkSession
  descriptor: BrowserAuthDescriptor | null
  /**
   * Why nobody can sign in here, once `initializeClerk` has decided. Null
   * while a sign-in flow is possible — including before initialization, where
   * the honest answer is that nothing has been asked yet.
   */
  unavailable: string | null
}>({ session: null, descriptor: null, unavailable: null })
const session = () => authResources().session
const descriptor = () => authResources().descriptor
const unavailable = () => authResources().unavailable
const setSession = (value: ClerkSession) => setAuthResources((current) => ({ ...current, session: value }))
const setDescriptor = (value: BrowserAuthDescriptor) =>
  setAuthResources((current) => ({ ...current, descriptor: value }))
const [user, setUser] = createSignal<AuthDisplayUser | null>(null)
// Start as false - will be set to true only when Clerk initialization starts
const [loading, setLoading] = createSignal(false)

/** Record an outcome in which this deployment signs nobody in. */
function reportUnavailable(reason: string) {
  setAuthResources((current) => ({ ...current, session: null, unavailable: reason }))
  setUser(null)
  setLoading(false)
}

function envString(input: unknown) {
  return typeof input === "string" ? input : undefined
}

/**
 * Initialize Clerk lazily. Only call this when auth is enabled.
 */
export function initializeClerk(deployment: BrowserAuthDeployment): Promise<void> {
  if (clerkLoadPromise) return clerkLoadPromise

  const bypass = testBrowserAuth()
  if (bypass.token || bypass.user) {
    setSession(null)
    setUser(bypass.user ?? { id: "test-user" })
    setLoading(false)
    return Promise.resolve()
  }

  // Post-sign-out under the e2e test-auth bypass: `testAuth()` now returns {}
  // (the signed-out marker is set), but the real Clerk SDK must NOT be loaded
  // to fill the gap — Tier M makes no real network calls. Stay anonymous. The
  // marker is only ever set by this module's own bypass `signOut()`, so real
  // local-dev Clerk sign-in (which never sets it) is unaffected.
  if (browserAuthTestSignedOut()) {
    setSession(null)
    setUser(null)
    setLoading(false)
    return Promise.resolve()
  }

  // Deployments with no sign-in flow at all (loopback central, non-HTTPS
  // origins) settle here, without a request and without loading the SDK.
  // `clerkLoadPromise` stays null, so `getAuthToken()` answers null rather
  // than awaiting a load that never happened.
  const unsupported = browserAuthUnavailable(deployment)
  if (unsupported) {
    reportUnavailable(unsupported)
    return Promise.resolve()
  }

  setLoading(true)
  clerkLoadPromise = loadBrowserAuthDescriptor({
    selectedAdapter: "clerk",
    apiOrigin: deployment.apiOrigin,
    appOrigin: deployment.appOrigin,
  })
    .then((live) => {
      setDescriptor(live)
      if (!clerkPubKey) throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required by the selected Clerk browser build")
      return import("@clerk/clerk-js/headless")
    })
    .then(async ({ Clerk }) => {
      const next = new Clerk(clerkPubKey)
      clerkInstance = next
      await next.load()
      const scope = window as typeof window & {
        __CLAXEDO_CLERK_TESTING__?: boolean
        Clerk?: ClerkInstance
      }
      if (scope.__CLAXEDO_CLERK_TESTING__) scope.Clerk = next
    })
    .then(() => {
      // Purge stale cross-account state if the user that loaded differs from
      // the last-seen account (e.g. Clerk restored a different session).
      handleAuthIdentityChange(clerkInstance!.user ?? null)
      setSession(clerkInstance!.session)
      setUser(clerkInstance!.user ?? null)
      setLoading(false)

      // Listen for auth state changes
      clerkInstance!.addListener((resources) => {
        // Detect an account switch (different non-null userId) and purge the
        // previous account's persisted `opencode.*` state before hydrating.
        handleAuthIdentityChange(resources.user ?? null)
        setSession(resources.session ?? null)
        setUser(resources.user ?? null)
      })
    })
    .catch((error: unknown) => {
      // The deployment answered with something this build cannot sign in
      // against, or did not answer at all. That is an anonymous session with a
      // reason — the shell and `/login` still render, and `signIn()` below
      // repeats this sentence to whoever tries.
      reportUnavailable(browserAuthUnavailableReason(error))
    })

  return clerkLoadPromise
}

async function reloadClerkDescriptor() {
  const expected = descriptor()
  if (!expected) throw new Error("Clerk browser adapter is not initialized")
  const live = await loadBrowserAuthDescriptor({
    selectedAdapter: "clerk",
    apiOrigin: new URL(expected.issuer).origin,
    appOrigin: window.location.origin,
  })
  assertBrowserAuthDescriptorBinding(expected, live)
  setDescriptor(live)
}

/**
 * Get the Clerk instance. Returns null if not initialized.
 */
export const clerk = {
  get instance() {
    return clerkInstance
  },
  get session() {
    return clerkInstance?.session ?? null
  },
  get user() {
    return clerkInstance?.user ?? null
  },
  get organization() {
    return clerkInstance?.organization ?? null
  },
  addListener(callback: (resources: ClerkResources) => void) {
    return clerkInstance?.addListener(callback) ?? (() => {})
  },
  redirectToSignIn(options?: ClerkSignInRedirectOptions) {
    return clerkInstance?.redirectToSignIn(options)
  },
  redirectToSignUp(options?: ClerkSignUpRedirectOptions) {
    return clerkInstance?.redirectToSignUp(options)
  },
  async signOut() {
    return clerkInstance?.signOut()
  },
}

async function ensureClerkLoaded() {
  if (!clerkLoadPromise) throw new Error("Clerk browser adapter is not initialized")
  if (clerkLoadPromise) await clerkLoadPromise
  return clerkInstance
}

/**
 * Wait for Clerk to be fully loaded.
 * Returns immediately if Clerk is not initialized (auth disabled).
 */
export async function waitForClerk(): Promise<void> {
  if (clerkLoadPromise) {
    await clerkLoadPromise
  }
}

/**
 * Get the current auth token for claxedo-server API calls.
 * Returns null if not authenticated or auth is disabled.
 */
export async function getAuthToken(options?: ClerkTokenOptions): Promise<string | null> {
  const testToken = testBrowserAuth().token
  if (testToken) return testToken
  if (!clerkLoadPromise) return null
  await clerkLoadPromise
  if (!clerkInstance?.session) return null

  // Use the convex-templated token by default so claxedo-server can forward it to Convex.
  // claxedo-server only checks issuer/signature; Convex requires aud="convex" via auth.config.ts.
  const token = await clerkInstance.session.getToken({ template: "convex", ...options })
  return token
}

/**
 * Auth hook for SolidJS components.
 * Provides reactive session state and auth methods.
 * Works safely even when auth is disabled (returns no-op functions).
 */
export function useAuth() {
  const clear = clearPersistedAuthState

  return {
    descriptor,
    methods: () => descriptor()?.methods ?? ["clerk"],
    /** Clerk instance */
    clerk,
    /** Reactive session accessor */
    session,
    /** Reactive user accessor */
    user,
    /** Loading state accessor */
    loading,
    /** Whether user is authenticated */
    isSignedIn: () => !!user() || !!session() || !!testBrowserAuth().user,
    /** Sign in through Clerk's hosted/redirect flow */
    signIn: async (options?: BrowserAuthSignInOptions) => {
      if (options?.method && options.method !== "clerk") {
        throw new Error(`sign-in method ${options.method} is not selected by the live Clerk descriptor`)
      }
      // E2E observability seam (DEV || prebuilt e2e bundle; stripped from real
      // production): the harness has no Clerk key, so the redirect is a no-op
      // and the UI's "Redirecting..." state clears within a microtask — the
      // only race-free way for a spec to prove Continue triggered sign-in is
      // recording the invocation itself.
      recordBrowserAuthTestSignIn(options?.redirectUrl)
      if (!clerkLoadPromise && (testBrowserAuth().token || testBrowserAuth().user)) return
      // The deployment has no sign-in flow, or its startup could not reach one.
      // Say which, rather than redirecting into a provider that is not there.
      const reason = unavailable()
      if (reason) throw new Error(reason)
      await reloadClerkDescriptor()
      const instance = await ensureClerkLoaded()
      const redirectUrl = options?.redirectUrl ?? window.location.origin
      await instance?.redirectToSignIn({
        redirectUrl,
        signInForceRedirectUrl: redirectUrl,
        signUpForceRedirectUrl: redirectUrl,
      } as ClerkSignInRedirectOptions)
    },
    /** Sign out and clear session */
    signOut: async () => {
      // The test-auth bypass branch of initializeClerk() never assigns
      // clerkLoadPromise, so the old `if (!clerkLoadPromise) return` guard made
      // sign-out a silent no-op under the bypass (persisted state survived a
      // Log out). Detect the bypass and mark the synthetic session signed out
      // so `testAuth()` stops reporting a signed principal; still purge state.
      const testUser = !!testBrowserAuth().user
      if (!clerkLoadPromise && !testUser) return
      if (testUser && typeof window !== "undefined") {
        markBrowserAuthTestSignedOut()
      }

      if (clerkLoadPromise) {
        await clerkLoadPromise
        await clerk.signOut().catch(() => undefined)
      }
      setSession(null)
      setUser(null)
      clear()
    },
    /** Sign up through Clerk's hosted/redirect flow */
    signUp: async (options?: BrowserAuthSignUpOptions) => {
      if (options?.method && options.method !== "clerk") {
        throw new Error(`sign-up method ${options.method} is not selected by the live Clerk descriptor`)
      }
      const reason = unavailable()
      if (reason) throw new Error(reason)
      await reloadClerkDescriptor()
      const instance = await ensureClerkLoaded()
      const redirectUrl = options?.redirectUrl ?? window.location.origin
      await instance?.redirectToSignUp({
        redirectUrl,
        signInForceRedirectUrl: redirectUrl,
        signUpForceRedirectUrl: redirectUrl,
      } as ClerkSignUpRedirectOptions)
    },
    /** Get auth token for API calls */
    getToken: getAuthToken,
    /** Refresh session */
    refreshSession: async () => {
      if (!clerkLoadPromise) return
      await clerkLoadPromise
      setSession(clerk.session)
      setUser(clerk.user)
    },
    /** Organization management (Clerk orgs) */
    organization: () => clerk.organization,
  }
}

export const browserAuthAdapter: BrowserAuthAdapter = {
  adapter: "clerk",
  transport: "bearer",
  implementationMarker: "claxedo-browser-auth:clerk",
  initialize: initializeClerk,
  useAuth,
  getToken: getAuthToken,
}

// Re-export for convenience
export { clerk as authClient }

export function useClerkConvexToken() {
  const [token, setToken] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(true)

  createEffect(() => {
    let mounted = true

    const updateToken = async () => {
      const newToken = await getAuthToken()
      if (mounted) {
        setToken(newToken)
        setIsLoading(false)
      }
    }

    // Initial token fetch
    void updateToken()

    // Re-fetch token when session changes
    const unsubscribe = clerk.addListener(() => {
      void updateToken()
    })

    onCleanup(() => {
      mounted = false
      unsubscribe()
    })
  })

  return { token, isLoading }
}
