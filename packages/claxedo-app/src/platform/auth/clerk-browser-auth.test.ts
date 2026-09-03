import { describe, expect, test } from "bun:test"
import { browserAuthAdapter } from "./clerk-browser-auth"

/**
 * The Clerk adapter is a module singleton (one Clerk instance per document),
 * so this file only exercises the startup outcome that leaves that singleton
 * untouched: the composition where no descriptor is requested and no provider
 * SDK is loaded. The HTTPS success/failure pair is proven against the Better
 * Auth adapter, which is a factory, and the loopback rule against
 * `app/entry/browser-auth-startup.ts`, which owns it.
 *
 * A plain-http deployment must resolve to an anonymous session with a reason,
 * so the shell and `/login` render for it.
 */
describe("Clerk browser adapter startup outcomes", () => {
  test("a plain-http deployment is anonymous, loads no SDK, and says why on sign-in", async () => {
    const requests: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return Response.json({})
    }) as typeof fetch

    try {
      await expect(
        browserAuthAdapter.initialize({ apiOrigin: "http://api.example.test", appOrigin: "http://app.example.test", centralTransport: "signed-web" }),
      ).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }

    const auth = browserAuthAdapter.useAuth()
    expect(requests).toEqual([])
    expect(auth.loading()).toBe(false)
    expect(auth.isSignedIn()).toBe(false)
    expect(auth.descriptor()).toBeNull()
    await expect(browserAuthAdapter.getToken()).resolves.toBeNull()
    await expect(auth.signIn()).rejects.toThrow(/HTTPS/)
  })
})
