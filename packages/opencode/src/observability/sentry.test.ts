import { describe, it, expect, beforeEach, mock } from "bun:test"

// Track all calls to Sentry SDK methods
const calls = {
  init: [] as any[],
  captureException: [] as any[],
  captureMessage: [] as any[],
  close: [] as any[],
}

// The beforeSend callback captured from Sentry.init()
let capturedBeforeSend: ((event: any) => any) | undefined

mock.module("@sentry/bun", () => ({
  init: (opts: any) => {
    calls.init.push(opts)
    capturedBeforeSend = opts.beforeSend
  },
  captureException: (...args: any[]) => {
    calls.captureException.push(args)
    return "event-id"
  },
  captureMessage: (...args: any[]) => {
    calls.captureMessage.push(args)
    return "event-id"
  },
  close: (timeout: number) => {
    calls.close.push(timeout)
    return Promise.resolve(true)
  },
}))

// Import AFTER mocking
const { initSentry, shutdownSentry, captureException, captureMessage } = await import("./sentry")

function resetCalls() {
  calls.init.length = 0
  calls.captureException.length = 0
  calls.captureMessage.length = 0
  calls.close.length = 0
}

describe("sentry module", () => {
  describe("guards: before init", () => {
    // These tests run BEFORE initSentry() is called.
    // captureException/captureMessage should silently no-op.

    it("captureException is a no-op when not initialized", () => {
      resetCalls()
      captureException(new Error("should be dropped"), { type: "test" })
      expect(calls.captureException).toHaveLength(0)
    })

    it("captureMessage is a no-op when not initialized", () => {
      resetCalls()
      captureMessage("should be dropped", "error")
      expect(calls.captureMessage).toHaveLength(0)
    })

    it("shutdownSentry is a no-op when not initialized", async () => {
      resetCalls()
      await shutdownSentry()
      expect(calls.close).toHaveLength(0)
    })
  })

  describe("initSentry", () => {
    beforeEach(() => {
      resetCalls()
      initSentry()
    })

    it("calls Sentry.init with DSN (env var or fallback)", () => {
      expect(calls.init).toHaveLength(1)
      const expected =
        process.env.SENTRY_DSN ||
        "https://2192aa324af989b3ac64c2c6950d04e1@o4509734987694080.ingest.us.sentry.io/4510886124716032"
      expect(calls.init[0].dsn).toBe(expected)
    })

    it("disables tracing (tracesSampleRate = 0)", () => {
      expect(calls.init[0].tracesSampleRate).toBe(0)
    })

    it("captures all errors (sampleRate = 1.0)", () => {
      expect(calls.init[0].sampleRate).toBe(1.0)
    })

    it("defaults environment to production", () => {
      expect(calls.init[0].environment).toBe(process.env.SENTRY_ENVIRONMENT || "production")
    })

    it("reads release from SENTRY_RELEASE env", () => {
      expect(calls.init[0].release).toBe(process.env.SENTRY_RELEASE || undefined)
    })

    it("ignores expected network errors", () => {
      const ignored = calls.init[0].ignoreErrors
      expect(ignored).toContain("ECONNRESET")
      expect(ignored).toContain("EPIPE")
      expect(ignored).toContain("ETIMEDOUT")
    })
  })

  describe("beforeSend tagging", () => {
    it("adds client tag", () => {
      const event = capturedBeforeSend!({ tags: {} })
      expect(event.tags.client).toBe("desktop-sidecar")
    })

    it("adds os_platform tag", () => {
      const event = capturedBeforeSend!({ tags: {} })
      expect(event.tags.os_platform).toBe(process.platform)
    })

    it("adds os_arch tag", () => {
      const event = capturedBeforeSend!({ tags: {} })
      expect(event.tags.os_arch).toBe(process.arch)
    })

    it("preserves existing tags", () => {
      const event = capturedBeforeSend!({ tags: { existing: "value" } })
      expect(event.tags.existing).toBe("value")
      expect(event.tags.client).toBe("desktop-sidecar")
    })
  })

  describe("captureException", () => {
    beforeEach(() => resetCalls())

    it("forwards error to Sentry.captureException", () => {
      const err = new Error("test error")
      captureException(err)
      expect(calls.captureException).toHaveLength(1)
      expect(calls.captureException[0][0]).toBe(err)
    })

    it("passes context as extra", () => {
      const err = new Error("test")
      captureException(err, { type: "uncaughtException", path: "/api/test" })
      expect(calls.captureException[0][1]).toEqual({
        extra: { type: "uncaughtException", path: "/api/test" },
      })
    })

    it("works without context", () => {
      captureException(new Error("no context"))
      expect(calls.captureException[0][1]).toEqual({ extra: undefined })
    })
  })

  describe("captureMessage", () => {
    beforeEach(() => resetCalls())

    it("forwards to Sentry.captureMessage with level", () => {
      captureMessage("something failed", "error")
      expect(calls.captureMessage).toHaveLength(1)
      expect(calls.captureMessage[0]).toEqual(["something failed", "error"])
    })

    it("defaults level to error", () => {
      captureMessage("oops")
      expect(calls.captureMessage[0][1]).toBe("error")
    })

    it("supports warning level", () => {
      captureMessage("watch out", "warning")
      expect(calls.captureMessage[0][1]).toBe("warning")
    })

    it("supports info level", () => {
      captureMessage("fyi", "info")
      expect(calls.captureMessage[0][1]).toBe("info")
    })
  })

  describe("shutdownSentry", () => {
    beforeEach(() => resetCalls())

    it("calls Sentry.close with 2s timeout", async () => {
      await shutdownSentry()
      expect(calls.close).toHaveLength(1)
      expect(calls.close[0]).toBe(2000)
    })

    it("makes subsequent captures no-op after shutdown", async () => {
      // After shutdown, initialized = false
      captureException(new Error("after shutdown"))
      expect(calls.captureException).toHaveLength(0)

      captureMessage("after shutdown")
      expect(calls.captureMessage).toHaveLength(0)
    })

    it("second shutdown is a no-op", async () => {
      await shutdownSentry()
      expect(calls.close).toHaveLength(0)
    })
  })
})

describe("onError filtering logic", () => {
  // Reproduce the exact filter condition from the patched server.ts:
  //   if (
  //     !(err instanceof NotFoundError) &&
  //     !(err instanceof HTTPException) &&
  //     !(err instanceof Provider.ModelNotFoundError)
  //   ) { captureException(...) }

  class NotFoundError extends Error {
    override name = "NotFoundError"
  }
  class HTTPException extends Error {
    override name = "HTTPException"
  }
  class ModelNotFoundError extends Error {
    override name = "ModelNotFoundError"
  }

  function shouldCapture(err: Error): boolean {
    return (
      !(err instanceof NotFoundError) &&
      !(err instanceof HTTPException) &&
      !(err instanceof ModelNotFoundError)
    )
  }

  it("captures generic Error", () => {
    expect(shouldCapture(new Error("server blew up"))).toBe(true)
  })

  it("captures TypeError", () => {
    expect(shouldCapture(new TypeError("cannot read property"))).toBe(true)
  })

  it("captures RangeError", () => {
    expect(shouldCapture(new RangeError("out of range"))).toBe(true)
  })

  it("skips NotFoundError (404)", () => {
    expect(shouldCapture(new NotFoundError("not found"))).toBe(false)
  })

  it("skips HTTPException (client errors)", () => {
    expect(shouldCapture(new HTTPException("unauthorized"))).toBe(false)
  })

  it("skips ModelNotFoundError (400)", () => {
    expect(shouldCapture(new ModelNotFoundError("model not found"))).toBe(false)
  })
})
