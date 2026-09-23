/**
 * Explicit Playwright auth helper for behaviors whose subject is a signed
 * user. General browser flows must not call this helper: the core suite runs
 * them once as Test User and once in local-unsigned/no-user mode.
 *
 * The shape matches what `src/platform/auth/browser-auth-test-bypass.ts` checks:
 *   window.__CLAXEDO_TEST_AUTH_TOKEN__ → returned by getAuthToken()
 *   window.__CLAXEDO_TEST_AUTH_USER__ → makes isSignedIn() return true
 */
import type { BrowserContext } from "@playwright/test"

export async function stampTestAuth(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
    w.__CLAXEDO_TEST_AUTH_USER__ = {
      id: "test-user",
      primaryEmailAddress: { emailAddress: "test@claxedo.test" },
      fullName: "Test User",
    }
  })
}
