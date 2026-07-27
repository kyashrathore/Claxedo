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
 * The wrapper is a no-op in dev builds and without a key, so both have to be
 * stubbed before the module is loaded for anything to reach the client.
 */
async function loadAnalytics() {
  vi.stubEnv("DEV", false)
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key")
  vi.resetModules()
  const analytics = await import("./analytics")
  analytics.initPostHog()
  // init resolves through the dynamic import; the queue drains after it.
  await vi.waitFor(() => expect(client.init).toHaveBeenCalled())
  return analytics
}

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
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key")
    vi.resetModules()
    const analytics = await import("./analytics")
    analytics.initPostHog()
    analytics.identify("early_user")
    expect(client.identify).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(client.identify).toHaveBeenCalledWith("early_user", undefined))
  })

  test("sends nothing when no key is configured", async () => {
    vi.stubEnv("DEV", false)
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

describe("deployment mode", () => {
  test("maps platform and auth signals onto the three planes", async () => {
    const { resolveDeploymentMode } = await import("./analytics")
    expect(resolveDeploymentMode({ platform: "desktop", authEnabled: true })).toBe("desktop-local")
    expect(resolveDeploymentMode({ platform: "desktop", authEnabled: false })).toBe("desktop-local")
    expect(resolveDeploymentMode({ platform: "web", authEnabled: true })).toBe("cloud")
    expect(resolveDeploymentMode({ platform: "web", authEnabled: false })).toBe("self-host")
  })
})
