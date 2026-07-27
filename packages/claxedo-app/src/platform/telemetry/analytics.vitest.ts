import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const client = {
  init: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
}

vi.mock("posthog-js", () => ({ default: client }))

/**
 * The wrapper is a no-op in dev builds, without the `on` opt-in, and without a
 * key, so all three have to be stubbed before the module is loaded for anything
 * to reach the client. Vite exposes only `VITE_`-prefixed variables to client
 * code, which is why the app's switch is `VITE_CLAXEDO_TELEMETRY_MODE` where
 * the server-side runtimes read `CLAXEDO_TELEMETRY_MODE`.
 */
async function loadAnalytics() {
  vi.stubEnv("DEV", false)
  vi.stubEnv("VITE_CLAXEDO_TELEMETRY_MODE", "on")
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key")
  vi.resetModules()
  const analytics = await import("./analytics")
  analytics.initPostHog()
  // init resolves through the dynamic import; the queue drains after it.
  await vi.waitFor(() => expect(client.init).toHaveBeenCalled())
  return analytics
}

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these builds rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

beforeEach(() => {
  for (const spy of Object.values(client)) spy.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("posthog wrapper", () => {
  test("initializes against the canonical ingest host", async () => {
    await loadAnalytics()
    expect(client.init).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ api_host: "https://us.i.posthog.com" }),
    )
  })

  test("forwards identify, group and reset to the client", async () => {
    const analytics = await loadAnalytics()

    analytics.identify("user_1", { plan: "free" })
    analytics.group("org", "org_1")
    expect(client.identify).toHaveBeenCalledWith("user_1", { plan: "free" })
    expect(client.group).toHaveBeenCalledWith("org", "org_1", undefined)

    analytics.reset()
    expect(client.reset).toHaveBeenCalled()
  })

  test("identityProps tracks the identified user and org", async () => {
    const analytics = await loadAnalytics()

    expect(analytics.identityProps()).toEqual({
      org_id: "anon",
      user_id: "anon",
      deployment_mode: "self-host",
    })

    analytics.setDeploymentMode("cloud")
    analytics.identify("user_1")
    analytics.group("org", "org_1")
    expect(analytics.identityProps()).toEqual({
      org_id: "org_1",
      user_id: "user_1",
      deployment_mode: "cloud",
    })

    analytics.reset()
    expect(analytics.identityProps()).toEqual({
      org_id: "anon",
      user_id: "anon",
      deployment_mode: "cloud",
    })
  })

  test("every capture payload carries the four required properties", async () => {
    const analytics = await loadAnalytics()
    analytics.setDeploymentMode("cloud")
    analytics.identify("user_1")
    analytics.group("org", "org_1")

    analytics.capture("session_new", { ...analytics.identityProps(), surface: "command_palette" })

    expect(client.capture).toHaveBeenCalledWith("session_new", {
      org_id: "org_1",
      user_id: "user_1",
      deployment_mode: "cloud",
      surface: "command_palette",
    })
  })

  test("boundary exceptions reach captureException with their surface", async () => {
    const analytics = await loadAnalytics()
    const error = new Error("boom")

    analytics.captureException(error, { ...analytics.identityProps(), surface: "error_page" })

    expect(client.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ surface: "error_page" }),
    )
  })

  test("queues calls made before the client is ready", async () => {
    vi.stubEnv("DEV", false)
    vi.stubEnv("VITE_CLAXEDO_TELEMETRY_MODE", "on")
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key")
    vi.resetModules()
    const analytics = await import("./analytics")
    analytics.initPostHog()
    analytics.identify("early_user")
    expect(client.identify).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(client.identify).toHaveBeenCalledWith("early_user", undefined))
  })

  test("opted in but no key configured → sends nothing", async () => {
    vi.stubEnv("DEV", false)
    vi.stubEnv("VITE_CLAXEDO_TELEMETRY_MODE", "on")
    vi.stubEnv("VITE_POSTHOG_KEY", "")
    vi.resetModules()
    const analytics = await import("./analytics")
    analytics.initPostHog()
    analytics.capture("session_new", { ...analytics.identityProps(), surface: "command_palette" })
    await Promise.resolve()

    expect(client.init).not.toHaveBeenCalled()
    expect(client.capture).not.toHaveBeenCalled()
  })
})

/**
 * VITE_CLAXEDO_TELEMETRY_MODE — the app's half of the W3 switch. `posthog-js`
 * is a singleton whose `init` constructs the instance, so "init was never
 * called" is this runtime's "no client was constructed"; nothing can reach the
 * network without it.
 */
describe("VITE_CLAXEDO_TELEMETRY_MODE", () => {
  /** Boots the wrapper as a production build with the given mode and a real-
   *  looking key, then exercises every call that could send. */
  async function loadWithMode(mode: string | undefined) {
    vi.stubEnv("DEV", false)
    if (mode === undefined) vi.stubEnv("VITE_CLAXEDO_TELEMETRY_MODE", "")
    else vi.stubEnv("VITE_CLAXEDO_TELEMETRY_MODE", mode)
    vi.stubEnv("VITE_POSTHOG_KEY", REAL_KEY)
    vi.resetModules()
    const analytics = await import("./analytics")
    analytics.initPostHog()
    analytics.identify("user_1")
    analytics.group("org", "org_1")
    analytics.capture("session_new", { ...analytics.identityProps(), surface: "command_palette" })
    analytics.captureException(new Error("boom"), { ...analytics.identityProps(), surface: "error_page" })
    // Let the dynamic import settle: an opted-in build would have inited by
    // the time this resolves, so a still-silent client is a real result.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return analytics
  }

  function expectSilent() {
    expect(client.init).not.toHaveBeenCalled()
    expect(client.identify).not.toHaveBeenCalled()
    expect(client.group).not.toHaveBeenCalled()
    expect(client.capture).not.toHaveBeenCalled()
    expect(client.captureException).not.toHaveBeenCalled()
  }

  test("mode off + a real-looking key → posthog-js is never initialized and nothing is sent", async () => {
    await loadWithMode("off")
    expectSilent()
  })

  test("mode unset + a real-looking key → still silent (opting in is deliberate)", async () => {
    await loadWithMode(undefined)
    expectSilent()
  })

  test("an unrecognized mode is not an opt-in", async () => {
    await loadWithMode("true")
    expectSilent()
  })

  test("`on` is matched case-insensitively after trimming", async () => {
    await loadWithMode("  ON  ")
    expect(client.init).toHaveBeenCalledWith(REAL_KEY, expect.objectContaining({ capture_exceptions: true }))
  })

  test("an opted-out build drops queued calls instead of accumulating them", async () => {
    const analytics = await loadWithMode("off")
    // The queue only ever drains through a client this build never constructs,
    // so anything retained here would sit in memory for the page's lifetime.
    // Re-running every sender must still leave the client untouched.
    for (let i = 0; i < 50; i++) {
      analytics.capture("session_new", { ...analytics.identityProps(), surface: "session" })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expectSilent()
  })
})

describe("deployment mode", () => {
  test("maps platform and auth signals onto the three planes", async () => {
    const { resolveDeploymentMode } = await import("./analytics")
    expect(resolveDeploymentMode({ platform: "desktop", authEnabled: true })).toBe("desktop-local")
    expect(resolveDeploymentMode({ platform: "desktop", authEnabled: false })).toBe("desktop-local")
    expect(resolveDeploymentMode({ platform: "web", authEnabled: true })).toBe("cloud")
    expect(resolveDeploymentMode({ platform: "web", authEnabled: false })).toBe("self-host")
  })
})
