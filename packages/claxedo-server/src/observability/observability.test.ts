import { afterEach, describe, expect, test, vi } from "vitest"
import { reportError, reportPaymentError, setErrorReporterSink } from "./report"
import { deploymentModeTag, resolveRelease, scrubSentryEvent, sentryInitOptions } from "./sentry-config"
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

  test("the I-5 scrub is wired into the ONE shared builder, so worker + server inherit it", () => {
    // worker.ts feeds this object straight into Sentry.withSentry, and
    // observability/node.ts forwards these same fields into Sentry.init —
    // fixing the leak here fixes it for both units exactly once.
    for (const unit of ["worker", "server", "relay"] as const) {
      const options = sentryInitOptions({ CLAXEDO_SENTRY_DSN: "https://key@o1.ingest.sentry.io/1" }, unit)
      expect(options.sendDefaultPii).toBe(false)
      const scrubbed = JSON.stringify(options.beforeSend(capturedRequestEvent()))
      for (const secret of SECRET_MATERIAL) {
        expect(scrubbed).not.toContain(secret)
      }
    }
  })
})

/**
 * I-5 tripwire: credential material must never leave the process on a Sentry
 * event.
 *
 * `capturedRequestEvent()` is NOT hand-written — it is the `event.request`
 * block @sentry/cloudflare 10.64.0 actually produced for a POST through
 * `Sentry.withSentry(env => sentryInitOptions(env, "worker"), handler)`,
 * captured off a stub transport. `sendDefaultPii` defaults to false and gates
 * none of it: requestDataIntegration copies headers verbatim, and
 * httpServerIntegration captures the request body regardless of
 * `dataCollection.httpBodies`. Remove `beforeSend` from sentryInitOptions and
 * these tests fail with live secrets in the payload.
 */
function capturedRequestEvent() {
  return {
    request: {
      headers: {
        authorization: "Bearer USER_BEARER_TOKEN_VALUE",
        "content-type": "application/json",
        "user-agent": "probe/1.0",
        "x-claxedo-service-token": "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_VALUE",
        "x-relay-resolver-token": "RELAY_RESOLVER_TOKEN_VALUE",
      },
      method: "POST",
      url: "https://control-plane.example/api/claxedo/credentials?service_token=QUERY_SERVICE_TOKEN_VALUE",
      query_string: "service_token=QUERY_SERVICE_TOKEN_VALUE",
      data: '{"provider":"anthropic","api_key":"sk-ant-BYOK_PROVIDER_API_KEY_VALUE","device_code":"DEVICE_CODE_VALUE","refresh_token":"CLI_REFRESH_TOKEN_VALUE"}',
      cookies: { __session: "CLERK_SESSION_COOKIE_VALUE" },
    },
  }
}

/** Every secret the hosted surface can put on a request. None may survive. */
const SECRET_MATERIAL = [
  "USER_BEARER_TOKEN_VALUE",
  "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_VALUE",
  "RELAY_RESOLVER_TOKEN_VALUE",
  "CLERK_SESSION_COOKIE_VALUE",
  "QUERY_SERVICE_TOKEN_VALUE",
  "sk-ant-BYOK_PROVIDER_API_KEY_VALUE",
  "DEVICE_CODE_VALUE",
  "CLI_REFRESH_TOKEN_VALUE",
]

describe("scrubSentryEvent (I-5: no credential material on events)", () => {
  test("no secret survives on a real captured @sentry/cloudflare request event", () => {
    const scrubbed = JSON.stringify(scrubSentryEvent(capturedRequestEvent()))
    for (const secret of SECRET_MATERIAL) {
      expect(scrubbed).not.toContain(secret)
    }
  })

  test("headers are ALLOW-listed, not deny-listed (an unknown x-*-token is dropped)", () => {
    const event = scrubSentryEvent(capturedRequestEvent())
    // Only known-safe headers remain; every token header is gone by default,
    // including ones nobody thought to enumerate.
    expect(event.request.headers).toEqual({
      "content-type": "application/json",
      "user-agent": "probe/1.0",
    })
  })

  test("body, query string and cookies are dropped; url keeps only origin+path", () => {
    const event = scrubSentryEvent(capturedRequestEvent()) as unknown as {
      request: Record<string, unknown>
    }
    expect(event.request.data).toBeUndefined()
    expect(event.request.query_string).toBeUndefined()
    expect(event.request.cookies).toBeUndefined()
    expect(event.request.url).toBe("https://control-plane.example/api/claxedo/credentials")
    // What actually debugs a 500 survives.
    expect(event.request.method).toBe("POST")
  })

  test("events without a request block pass through untouched", () => {
    expect(scrubSentryEvent({ message: "boom" })).toEqual({ message: "boom" })
    expect(() => scrubSentryEvent(undefined)).not.toThrow()
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
    // I-5: the Node server must init WITH the scrub, not just define it.
    expect(initArg.sendDefaultPii).toBe(false)
    const scrubbed = JSON.stringify(initArg.beforeSend(capturedRequestEvent()))
    for (const secret of SECRET_MATERIAL) {
      expect(scrubbed).not.toContain(secret)
    }

    const err = new Error("route blew up")
    reportError(err, { tags: { source: "server_route" } })
    expect(sentryNodeMock.captureException).toHaveBeenCalledWith(err)
  })
})
