import { describe, expect, test } from "vitest"

import { redactText, sanitizeAttributes, sanitizeSpan } from "./redact"
import type { FinishedSpan } from "./span"

describe("redactText", () => {
  test("strips userinfo credentials from URLs, keeping host and path", () => {
    expect(redactText("POST https://deploy:s3cret-pw@relay.example.com/v1/traces failed")).toBe(
      "POST https://[redacted]@relay.example.com/v1/traces failed",
    )
  })

  test("strips authorization-scheme tokens", () => {
    expect(redactText("upstream rejected Bearer sk_live_abc123")).toBe("upstream rejected Bearer [redacted]")
    expect(redactText("send Basic dXNlcjpwYXNz in the header")).toBe("send Basic [redacted] in the header")
  })

  test("strips key=value secrets from query strings and JSON bodies", () => {
    const out = redactText(
      `callback=https://a.b/c?token=tok_123&ok=1 body={"password":"hunter2","note":"kept"} client_secret=shhh`,
    )
    expect(out).toContain("token=[redacted]")
    expect(out).toContain(`"password":"[redacted]"`)
    expect(out).toContain("client_secret=[redacted]")
    expect(out).not.toContain("tok_123")
    expect(out).not.toContain("hunter2")
    expect(out).not.toContain("shhh")
    expect(out).toContain("ok=1")
    expect(out).toContain(`"note":"kept"`)
  })

  test("caps oversized text", () => {
    const out = redactText("x".repeat(5000))
    expect(out.length).toBeLessThan(600)
    expect(out.endsWith("…")).toBe(true)
  })

  test("is idempotent — a second pass changes nothing", () => {
    const once = redactText("Bearer abc token=x https://u:p@h failed")
    expect(redactText(once)).toBe(once)
  })

  test("leaves ordinary text alone", () => {
    expect(redactText("connection refused after 3 retries")).toBe("connection refused after 3 retries")
  })
})

describe("sanitizeAttributes", () => {
  test("drops undeclared keys and scrubs the string values it keeps", () => {
    const out = sanitizeAttributes(
      { keep: "Bearer tok", drop: "x", n: 5, miss: undefined },
      new Set(["keep", "n", "miss"]),
    )
    expect(out).toEqual({ keep: "Bearer [redacted]", n: 5, miss: undefined })
  })

  test("without a declaration keeps every key but still scrubs", () => {
    expect(sanitizeAttributes({ url: "https://u:p@h", n: 1 })).toEqual({
      url: "https://[redacted]@h",
      n: 1,
    })
  })
})

describe("sanitizeSpan", () => {
  function span(): FinishedSpan {
    return {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "fetch",
      kind: "client",
      startTimeUnixNano: 1n,
      endTimeUnixNano: 2n,
      attributes: { "http.url": "https://u:p@h", "debug.raw": "token=abc" },
      status: "error",
      statusMessage: "401 Authorization: Bearer tok_9",
      events: [{ name: "exception", timeUnixNano: 1n, attributes: { "exception.message": "password=hunter2" } }],
    }
  }

  test("scrubs every field a span carries", () => {
    const out = sanitizeSpan(span())
    const serialized = JSON.stringify(out, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    )
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("tok_9")
    expect(out.attributes["http.url"]).toBe("https://[redacted]@h")
    expect(out.statusMessage).toBe("401 Authorization: [redacted] [redacted]")
  })

  test("applies the allowlist to span and event attributes alike", () => {
    const out = sanitizeSpan(span(), new Set(["http.url", "exception.message"]))
    expect(out.attributes).toEqual({ "http.url": "https://[redacted]@h" })
    expect(Object.keys(out.events[0]!.attributes!)).toEqual(["exception.message"])
  })
})
