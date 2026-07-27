import { afterEach, describe, expect, test, vi } from "vitest"
import { reportError, reportPaymentError, setErrorReporterSink } from "./report"
import { deploymentModeTag, observabilityOptions, resolveRelease, resolveTelemetryHost, resolveTelemetryKey } from "./config"
import { initNodeObservability } from "./node"
import { shutdownPostHog } from "../posthog"

/**
 * Observability gates.
 *
 * The load-bearing contract: with no PostHog key configured (the self-host
 * default) every entrypoint's observability is a clean disabled no-op — no
 * init, no network, no throw. The privacy promise "no keys configured ⇒
 * nothing is sent" is exactly these assertions.
 */

const postHogMock = vi.hoisted(() => {
  const captureException = vi.fn()
  const capture = vi.fn()
  const shutdown = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const construct = vi.fn()
  class PostHog {
    captureException = captureException
    capture = capture
    shutdown = shutdown
    flush = flush
    constructor(key: string, options: unknown) {
      construct(key, options)
    }
  }
  return { PostHog, captureException, capture, shutdown, flush, construct }
})

vi.mock("posthog-node", () => ({ PostHog: postHogMock.PostHog }))

afterEach(async () => {
  setErrorReporterSink(undefined)
  // The client is module-cached in posthog.ts; drop it so each test's env wins.
  await shutdownPostHog()
  postHogMock.construct.mockClear()
  postHogMock.captureException.mockClear()
  postHogMock.capture.mockClear()
})

describe("observabilityOptions", () => {
  test("key absent → disabled no-op options (enabled false, no key)", () => {
    const options = observabilityOptions({}, "worker")
    expect(options.enabled).toBe(false)
    expect(options.key).toBeUndefined()
  })

  test("whitespace-only key counts as absent", () => {
    expect(observabilityOptions({ CLAXEDO_POSTHOG_KEY: "   " }, "server").enabled).toBe(false)
  })

  test("key present → enabled, tagged with unit and deployment mode", () => {
    const options = observabilityOptions(
      {
        CLAXEDO_POSTHOG_KEY: "phc_abc",
        CLAXEDO_RELEASE: "abc123",
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
      },
      "worker",
    )
    expect(options.enabled).toBe(true)
    expect(options.key).toBe("phc_abc")
    expect(options.release).toBe("abc123")
    expect(options.host).toBe("https://us.i.posthog.com")
    expect(options.tags).toEqual({ unit: "worker", deployment_mode: "hosted", release: "abc123" })
  })
})

describe("resolveTelemetryKey / resolveTelemetryHost", () => {
  test("CLAXEDO_POSTHOG_KEY wins over the unprefixed alias", () => {
    expect(resolveTelemetryKey({ CLAXEDO_POSTHOG_KEY: "a", POSTHOG_KEY: "b" })).toBe("a")
    expect(resolveTelemetryKey({ POSTHOG_KEY: "b" })).toBe("b")
    expect(resolveTelemetryKey({})).toBeUndefined()
  })

  test("host defaults to the canonical ingest host and never keeps a trailing slash", () => {
    expect(resolveTelemetryHost({})).toBe("https://us.i.posthog.com")
    expect(resolveTelemetryHost({ CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com/" })).toBe("https://eu.i.posthog.com")
    expect(resolveTelemetryHost({ POSTHOG_HOST: "https://ph.internal//" })).toBe("https://ph.internal")
  })
})

describe("resolveRelease", () => {
  test("CLAXEDO_RELEASE wins over GIT_SHA", () => {
    expect(resolveRelease({ CLAXEDO_RELEASE: "a", GIT_SHA: "b" })).toBe("a")
  })

  test("falls back GIT_SHA → undefined; vendor-named release vars are not read", () => {
    expect(resolveRelease({ GIT_SHA: "b" })).toBe("b")
    expect(resolveRelease({ SENTRY_RELEASE: "c" })).toBeUndefined()
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
  test("key absent → { enabled: false }, no client is constructed (no network)", () => {
    expect(initNodeObservability({})).toEqual({ enabled: false })
    expect(postHogMock.construct).not.toHaveBeenCalled()
    // And no sink got registered: reports stay no-ops.
    reportError(new Error("still nobody listening"))
    expect(postHogMock.captureException).not.toHaveBeenCalled()
  })

  test("key present → client built with host/flush options and the sink forwards reports", () => {
    const result = initNodeObservability({
      CLAXEDO_POSTHOG_KEY: "phc_server",
      GIT_SHA: "deadbeef",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
    })
    expect(result).toEqual({ enabled: true })
    expect(postHogMock.construct).toHaveBeenCalledTimes(1)
    const [key, options] = postHogMock.construct.mock.calls[0] as [string, { host: string }]
    expect(key).toBe("phc_server")
    expect(options.host).toBe("https://us.i.posthog.com")

    const err = new Error("route blew up")
    reportError(err, { tags: { source: "server_route" }, extra: { path: "/x" } })
    expect(postHogMock.captureException).toHaveBeenCalledWith(err, "system", {
      unit: "server",
      deployment_mode: "hosted",
      release: "deadbeef",
      source: "server_route",
      path: "/x",
    })
  })

  test("a call site that knows the user keys the exception to them, not to system", () => {
    initNodeObservability({ CLAXEDO_POSTHOG_KEY: "phc_server" })
    const err = new Error("checkout failed")
    reportPaymentError(err, { tags: { user_id: "user_42" } })
    expect(postHogMock.captureException).toHaveBeenCalledWith(err, "user_42", {
      unit: "server",
      deployment_mode: "self-host",
      user_id: "user_42",
      page_class: "payment",
    })
  })
})
