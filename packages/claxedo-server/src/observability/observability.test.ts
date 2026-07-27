import { afterEach, describe, expect, test, vi } from "vitest"
import { reportError, reportPaymentError, setErrorReporterSink } from "./report"
import { deploymentModeTag, resolveRelease, sentryInitOptions } from "./sentry-config"
import { initNodeObservability } from "./node"

/**
 * D12 observability gates.
 *
 * The load-bearing contract: with no DSN configured (the owner has no Sentry
 * account yet) every entrypoint's observability is a clean disabled no-op —
 * no init, no network, no throw.
 */

const sentryNodeMock = vi.hoisted(() => ({
  init: vi.fn(),
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setTags: vi.fn(), setExtras: vi.fn() }),
  ),
  captureException: vi.fn(),
}))

vi.mock("@sentry/node", () => sentryNodeMock)

afterEach(() => {
  setErrorReporterSink(undefined)
  sentryNodeMock.init.mockClear()
  sentryNodeMock.captureException.mockClear()
})

describe("sentryInitOptions", () => {
  test("DSN absent → disabled no-op options (enabled false, no dsn)", () => {
    const options = sentryInitOptions({}, "worker")
    expect(options.enabled).toBe(false)
    expect(options.dsn).toBeUndefined()
    // Tracing stays off regardless (ADR: tracing is where Sentry gets expensive).
    expect(options.tracesSampleRate).toBe(0)
  })

  test("whitespace-only DSN counts as absent", () => {
    expect(sentryInitOptions({ CLAXEDO_SENTRY_DSN: "   " }, "server").enabled).toBe(false)
  })

  test("DSN present → enabled, tagged with unit and deployment mode, tracing off", () => {
    const options = sentryInitOptions(
      {
        CLAXEDO_SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
        CLAXEDO_RELEASE: "abc123",
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
      },
      "worker",
    )
    expect(options.enabled).toBe(true)
    expect(options.dsn).toBe("https://key@o1.ingest.sentry.io/1")
    expect(options.release).toBe("abc123")
    expect(options.tracesSampleRate).toBe(0)
    expect(options.initialScope.tags).toEqual({ unit: "worker", deployment_mode: "hosted" })
  })
})

describe("resolveRelease", () => {
  test("CLAXEDO_RELEASE wins over GIT_SHA and SENTRY_RELEASE", () => {
    expect(
      resolveRelease({ CLAXEDO_RELEASE: "a", GIT_SHA: "b", SENTRY_RELEASE: "c" }),
    ).toBe("a")
  })

  test("falls back GIT_SHA → SENTRY_RELEASE → undefined", () => {
    expect(resolveRelease({ GIT_SHA: "b", SENTRY_RELEASE: "c" })).toBe("b")
    expect(resolveRelease({ SENTRY_RELEASE: "c" })).toBe("c")
    expect(resolveRelease({})).toBeUndefined()
  })
})

describe("deploymentModeTag", () => {
  test("absent mode = self-host (D9 default); hosted passes through lowercased", () => {
    expect(deploymentModeTag({})).toBe("self-host")
    expect(deploymentModeTag({ CLAXEDO_DEPLOYMENT_MODE: "HOSTED" })).toBe("hosted")
  })

  test("never throws on unrecognized values (reports posture, does not enforce it)", () => {
    expect(deploymentModeTag({ CLAXEDO_DEPLOYMENT_MODE: "banana" })).toBe("banana")
  })
})

describe("report seam", () => {
  test("reportError without a sink is a silent no-op", () => {
    expect(() => reportError(new Error("nobody listening"))).not.toThrow()
  })

  test("sink receives error, tags, and extra", () => {
    const sink = vi.fn()
    setErrorReporterSink(sink)
    const err = new Error("boom")
    reportError(err, { tags: { source: "test" }, extra: { path: "/x" } })
    expect(sink).toHaveBeenCalledWith(err, {
      tags: { source: "test" },
      extra: { path: "/x" },
    })
  })

  test("reportPaymentError stamps the payment page class (ADR page class 1 of 2)", () => {
    const sink = vi.fn()
    setErrorReporterSink(sink)
    reportPaymentError(new Error("webhook signature failed"), { tags: { route: "polar_webhook" } })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]![1]).toEqual({
      tags: { route: "polar_webhook", page_class: "payment" },
      extra: {},
    })
  })

  test("a throwing sink never propagates into the request path", () => {
    setErrorReporterSink(() => {
      throw new Error("sink exploded")
    })
    expect(() => reportError(new Error("original"))).not.toThrow()
  })
})

describe("initNodeObservability", () => {
  test("DSN absent → { enabled: false } and Sentry.init is NEVER called (no network)", () => {
    expect(initNodeObservability({})).toEqual({ enabled: false })
    expect(sentryNodeMock.init).not.toHaveBeenCalled()
    // And no sink got registered: reports stay no-ops.
    reportError(new Error("still nobody listening"))
    expect(sentryNodeMock.captureException).not.toHaveBeenCalled()
  })

  test("DSN present → init called with dsn/release/tags and the sink forwards reports", () => {
    const result = initNodeObservability({
      CLAXEDO_SENTRY_DSN: "https://key@o1.ingest.sentry.io/2",
      GIT_SHA: "deadbeef",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
    })
    expect(result).toEqual({ enabled: true })
    expect(sentryNodeMock.init).toHaveBeenCalledTimes(1)
    const initArg = sentryNodeMock.init.mock.calls[0]![0]
    expect(initArg.dsn).toBe("https://key@o1.ingest.sentry.io/2")
    expect(initArg.release).toBe("deadbeef")
    expect(initArg.tracesSampleRate).toBe(0)
    expect(initArg.initialScope.tags).toEqual({ unit: "server", deployment_mode: "hosted" })

    const err = new Error("route blew up")
    reportError(err, { tags: { source: "server_route" } })
    expect(sentryNodeMock.captureException).toHaveBeenCalledWith(err)
  })
})
