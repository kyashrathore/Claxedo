/**
 * Global Playwright setup: stamp the test-auth bypass on every page so the
 * cloud-mode auth guard does not redirect to /login during tests. This
 * mirrors what the desktop client does internally for sign-in via Clerk.
 *
 * The shape matches what auth-client.ts checks:
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
