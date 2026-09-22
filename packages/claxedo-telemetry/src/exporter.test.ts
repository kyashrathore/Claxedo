import { describe, expect, test } from "vitest"

import { createOtlpExporter } from "./exporter"
import type { FinishedSpan } from "./span"

function span(): FinishedSpan {
  return {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    name: "op",
    kind: "internal",
    startTimeUnixNano: 1n,
    endTimeUnixNano: 2n,
    attributes: {},
    status: "unset",
    events: [],
  }
}

function fetchRecorder() {
  const calls: { url: string; body: string }[] = []
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" })
    return new Response("{}")
  }
  return { calls, fake }
}

describe("consent", () => {
  test("an exporter built without a consent answer never sends", async () => {
    const { calls, fake } = fetchRecorder()
    const exporter = createOtlpExporter({
      endpoint: "http://127.0.0.1:4318",
      resource: { serviceName: "svc" },
      fetch: fake,
    })
    exporter.accept(span())
    await exporter.flush()
    expect(calls).toHaveLength(0)
  })

  test("denied consent drops the span before it is queued", async () => {
    const { calls, fake } = fetchRecorder()
    const exporter = createOtlpExporter({
      endpoint: "http://127.0.0.1:4318",
      resource: { serviceName: "svc" },
      consent: () => false,
      fetch: fake,
    })
    exporter.accept(span())
    await exporter.flush()
    expect(calls).toHaveLength(0)
  })

  /**
   * Consent is re-checked at send time, not only at accept: a span queued
   * while consent held must not leave the process after it is withdrawn.
   */
  test("consent withdrawn after queueing still stops the send", async () => {
    const { calls, fake } = fetchRecorder()
    let granted = true
    const exporter = createOtlpExporter({
      endpoint: "http://127.0.0.1:4318",
      resource: { serviceName: "svc" },
      consent: () => granted,
      fetch: fake,
    })
    exporter.accept(span())
    granted = false
    await exporter.flush()
    expect(calls).toHaveLength(0)
  })

  test("a throwing consent check fails closed instead of rejecting flush", async () => {
    const { calls, fake } = fetchRecorder()
    const exporter = createOtlpExporter({
      endpoint: "http://127.0.0.1:4318",
      resource: { serviceName: "svc" },
      consent: () => {
        throw new Error("consent store down")
      },
      fetch: fake,
    })
    exporter.accept(span())
    await expect(exporter.flush()).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test("granted consent posts the batch to /v1/traces", async () => {
    const { calls, fake } = fetchRecorder()
    const exporter = createOtlpExporter({
      endpoint: "http://collector:4318/",
      resource: { serviceName: "svc" },
      consent: () => true,
      fetch: fake,
    })
    exporter.accept(span())
    await exporter.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("http://collector:4318/v1/traces")
    expect(calls[0]!.body).toContain("4bf92f3577b34da6a3ce929d0e0e4736")
  })
})
