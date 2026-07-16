import { createEffect, createSignal, onCleanup } from "solid-js";
import { isProjectionCacheKey } from "@/platform/persistence/keys";

/**
 * Clerk client instance for Claxedo cloud mode.
 * Lazily initialized only when auth is enabled.
 */
const clerkPubKey = envString(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) ?? "";

type ClerkTokenOptions = {
  template?: "convex";
  skipCache?: boolean;
}

type ClerkInstance = InstanceType<typeof import("@clerk/clerk-js/headless").Clerk>
type ClerkSession = ClerkInstance["session"]
type ClerkResources = Parameters<ClerkInstance["addListener"]>[0] extends (resources: infer Resources) => unknown ? Resources : never
type ClerkSignInRedirectOptions = Parameters<ClerkInstance["redirectToSignIn"]>[0]
type ClerkSignUpRedirectOptions = Parameters<ClerkInstance["redirectToSignUp"]>[0]

// Lazy Clerk instance - only created when needed
let clerkInstance: ClerkInstance | null = null;
let clerkLoadPromise: Promise<void> | null = null;

/**
 * Dedicated key tracking the last signed-in Clerk user id. Survives the
 * persisted-state purge so an account switch can be detected on the NEXT
 * identity change. NOT itself wiped by clearPersistedAuthState().
 */
const LAST_USER_ID_KEY = "opencode.auth.lastUserId";

/**
 * Purge all claxedo `opencode.*` persisted state (workspace list, layout, etc)
 * plus projection-cache keys. Used by both explicit sign-out and the
 * auth-identity-change guard. The dedicated lastUserId key is preserved so a
 * subsequent account switch can still be detected.
 */
export function clearPersistedAuthState() {
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key === LAST_USER_ID_KEY) continue;
    if (!key.startsWith("opencode.") && !isProjectionCacheKey(key)) continue;
    localStorage.removeItem(key);
  }
}

/**
 * Extract a stable user id from an unknown Clerk user resource.
 */
function userIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
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
  const nextId = userIdOf(nextUser);
  if (!nextId) return;

  let lastId: string | null = null;
  try {
    lastId = localStorage.getItem(LAST_USER_ID_KEY);
  } catch {
    lastId = null;
  }

  if (lastId && lastId !== nextId) {
    // Different account on the same browser — purge stale state BEFORE the app
    // hydrates the new account's data. clearPersistedAuthState preserves the
    // lastUserId key, which we overwrite immediately below.
    clearPersistedAuthState();
  }

  if (lastId !== nextId) {
    try {
      localStorage.setItem(LAST_USER_ID_KEY, nextId);
    } catch {
      /* ignore */
    }
  }
}

// SolidJS Signals for auth state
const [session, setSession] = createSignal<ClerkSession>(null);
const [user, setUser] = createSignal<unknown>(null);
// Start as false - will be set to true only when Clerk initialization starts
const [loading, setLoading] = createSignal(false);

function envString(input: unknown) {
  return typeof input === "string" ? input : undefined;
}

function storedAuth(raw: string): { token?: string; user?: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return {
    ...("token" in parsed && typeof parsed.token === "string" ? { token: parsed.token } : {}),
    ...("user" in parsed && parsed.user !== undefined ? { user: parsed.user } : {}),
  };
}

function testAuth(): {
  __CLAXEDO_TEST_AUTH_TOKEN__?: string;
  __CLAXEDO_TEST_AUTH_USER__?: unknown;
} {
  if (!import.meta.env.DEV && import.meta.env.MODE !== "test") return {};
  if (typeof window === "undefined") return {};
  const w = window as typeof window & {
    __CLAXEDO_TEST_AUTH_TOKEN__?: string;
    __CLAXEDO_TEST_AUTH_USER__?: unknown;
    __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean;
  };
  if (w.__CLAXEDO_TEST_AUTH_TOKEN__ || w.__CLAXEDO_TEST_AUTH_USER__) return w;
  if (
    import.meta.env.VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS === "1" ||
    w.__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__
  ) return {};
  // localStorage fallback so harness/CI/preview can persist a session across
  // page reloads without injecting init scripts. Set
  //   localStorage.opencode_test_auth = JSON.stringify({token, user})
  // and the next page load will pick it up.
  try {
    const raw = window.localStorage.getItem("opencode_test_auth");
    if (raw) {
      const parsed = storedAuth(raw);
      if (parsed.token || parsed.user) {
        return {
          __CLAXEDO_TEST_AUTH_TOKEN__: parsed.token,
          __CLAXEDO_TEST_AUTH_USER__: parsed.user,
        };
      }
    }
  } catch {
    /* ignore */
  }
  // Auto-bypass under playwright/webdriver so tests don't need to inject
  // init scripts. Production users never have navigator.webdriver === true.
  if (typeof navigator !== "undefined" && navigator.webdriver) {
    return {
      __CLAXEDO_TEST_AUTH_TOKEN__: "test-bypass-token",
      __CLAXEDO_TEST_AUTH_USER__: {
        id: "test-user",
        primaryEmailAddress: { emailAddress: "test@claxedo.test" },
        fullName: "Test User",
      },
    };
  }
  return w;
}

/**
 * Initialize Clerk lazily. Only call this when auth is enabled.
 */
export function initializeClerk(): Promise<void> {
  if (clerkLoadPromise) return clerkLoadPromise;

  const bypass = testAuth();
  if (bypass.__CLAXEDO_TEST_AUTH_TOKEN__ || bypass.__CLAXEDO_TEST_AUTH_USER__) {
    setSession(null);
    setUser(bypass.__CLAXEDO_TEST_AUTH_USER__ ?? { id: "test-user" });
    setLoading(false);
    return Promise.resolve();
  }

  if (!clerkPubKey) {
    return Promise.resolve();
  }

  setLoading(true);
  clerkLoadPromise = import("@clerk/clerk-js/headless")
    .then(async ({ Clerk }) => {
      const next = new Clerk(clerkPubKey);
      clerkInstance = next;
      await next.load();
      const scope = window as typeof window & {
        __CLAXEDO_CLERK_TESTING__?: boolean;
        Clerk?: ClerkInstance;
      };
      if (scope.__CLAXEDO_CLERK_TESTING__) scope.Clerk = next;
    })
    .then(() => {
      // Purge stale cross-account state if the user that loaded differs from
      // the last-seen account (e.g. Clerk restored a different session).
      handleAuthIdentityChange(clerkInstance!.user ?? null);
      setSession(clerkInstance!.session);
      setUser(clerkInstance!.user);
      setLoading(false);

      // Listen for auth state changes
      clerkInstance!.addListener((resources) => {
        // Detect an account switch (different non-null userId) and purge the
        // previous account's persisted `opencode.*` state before hydrating.
        handleAuthIdentityChange(resources.user ?? null);
        setSession(resources.session ?? null);
        setUser(resources.user ?? null);
      });
    });

  return clerkLoadPromise;
}

/**
 * Get the Clerk instance. Returns null if not initialized.
 */
export const clerk = {
  get instance() {
    return clerkInstance;
  },
  get session() {
    return clerkInstance?.session ?? null;
  },
  get user() {
    return clerkInstance?.user ?? null;
  },
  get organization() {
    return clerkInstance?.organization ?? null;
  },
  addListener(callback: (resources: ClerkResources) => void) {
    return clerkInstance?.addListener(callback) ?? (() => {});
  },
  redirectToSignIn(options?: ClerkSignInRedirectOptions) {
    return clerkInstance?.redirectToSignIn(options);
  },
  redirectToSignUp(options?: ClerkSignUpRedirectOptions) {
    return clerkInstance?.redirectToSignUp(options);
  },
  async signOut() {
    return clerkInstance?.signOut();
  },
};

async function ensureClerkLoaded() {
  if (!clerkLoadPromise && clerkPubKey) await initializeClerk();
  if (clerkLoadPromise) await clerkLoadPromise;
  return clerkInstance;
}

/**
 * Wait for Clerk to be fully loaded.
 * Returns immediately if Clerk is not initialized (auth disabled).
 */
export async function waitForClerk(): Promise<void> {
  if (clerkLoadPromise) {
    await clerkLoadPromise;
  }
}

/**
 * Get the current auth token for claxedo-server API calls.
 * Returns null if not authenticated or auth is disabled.
 */
export async function getAuthToken(options?: ClerkTokenOptions): Promise<string | null> {
  const testToken = testAuth().__CLAXEDO_TEST_AUTH_TOKEN__;
  if (testToken) return testToken;
  if (!clerkLoadPromise && envString(import.meta.env.VITE_AUTH_ENABLED) === "true" && clerkPubKey) {
    await initializeClerk();
  }
  if (!clerkLoadPromise) return null;
  await clerkLoadPromise;
  if (!clerkInstance?.session) return null;

  // Use the convex-templated token by default so claxedo-server can forward it to Convex.
  // claxedo-server only checks issuer/signature; Convex requires aud="convex" via auth.config.ts.
  const token = await clerkInstance.session.getToken({ template: "convex", ...options });
  return token;
}

/**
 * Auth hook for SolidJS components.
 * Provides reactive session state and auth methods.
 * Works safely even when auth is disabled (returns no-op functions).
 */
export function useAuth() {
  const clear = clearPersistedAuthState;

  return {
    /** Clerk instance */
    clerk,
    /** Reactive session accessor */
    session,
    /** Reactive user accessor */
    user,
    /** Loading state accessor */
    loading,
    /** Whether user is authenticated */
    isSignedIn: () => !!user() || !!session() || !!testAuth().__CLAXEDO_TEST_AUTH_USER__,
    /** Sign in through Clerk's hosted/redirect flow */
    signIn: async (options?: { redirectUrl?: string }) => {
      const instance = await ensureClerkLoaded();
      const redirectUrl = options?.redirectUrl ?? window.location.origin;
      await instance?.redirectToSignIn({
        redirectUrl,
        signInForceRedirectUrl: redirectUrl,
        signUpForceRedirectUrl: redirectUrl,
      } as ClerkSignInRedirectOptions);
    },
    /** Sign out and clear session */
    signOut: async () => {
      if (!clerkLoadPromise) return;
      await clerkLoadPromise;

      await clerk.signOut().catch(() => undefined);
      setSession(null);
      setUser(null);
      clear();
    },
    /** Sign up through Clerk's hosted/redirect flow */
    signUp: async (options?: { redirectUrl?: string }) => {
      const instance = await ensureClerkLoaded();
      const redirectUrl = options?.redirectUrl ?? window.location.origin;
      await instance?.redirectToSignUp({
        redirectUrl,
        signInForceRedirectUrl: redirectUrl,
        signUpForceRedirectUrl: redirectUrl,
      } as ClerkSignUpRedirectOptions);
    },
    /** Get auth token for API calls */
    getToken: getAuthToken,
    /** Refresh session */
    refreshSession: async () => {
      if (!clerkLoadPromise) return;
      await clerkLoadPromise;
      setSession(clerk.session);
      setUser(clerk.user);
    },
    /** Organization management (Clerk orgs) */
    organization: clerk.organization,
  };
}

// Re-export for convenience
export { clerk as authClient };

export function useClerkConvexToken() {
  const [token, setToken] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(true);

  createEffect(() => {
    let mounted = true;

    const updateToken = async () => {
      const newToken = await getAuthToken();
      if (mounted) {
        setToken(newToken);
        setIsLoading(false);
      }
    };

    // Initial token fetch
    void updateToken();

    // Re-fetch token when session changes
    const unsubscribe = clerk.addListener(() => {
      void updateToken();
    });

    onCleanup(() => {
      mounted = false;
      unsubscribe();
    });
  });

  return { token, isLoading };
}
