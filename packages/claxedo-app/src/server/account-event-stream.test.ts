/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedStreamBridge } from "@claxedo/account-contract"
import { accountEventResponse } from "./account-event-stream"

function bridgeHarness() {
  const chunks = new Set<(payload: { streamId: string; text: string }) => void>()
  const ends = new Set<(payload: { streamId: string }) => void>()
  const errors = new Set<(payload: { streamId: string; message: string }) => void>()
  const opens: Array<{ operation: string; input?: Record<string, unknown> }> = []
  const closed: string[] = []
  const bridge: HostedStreamBridge = {
    streamOpen: async (operation, input) => { opens.push({ operation, input }); return { streamId: "stream-1" } },
    streamStart: async (streamId) => {
      for (const listener of chunks) listener({ streamId: "another-stream", text: "ignored" })
      for (const listener of chunks) listener({ streamId, text: 'data: {"type":"session.attention.raised"}\n\n' })
    },
    streamClose: async (streamId) => { closed.push(streamId) },
    onStreamChunk: (listener) => { chunks.add(listener); return () => chunks.delete(listener) },
    onStreamEnd: (listener) => { ends.add(listener); return () => ends.delete(listener) },
    onStreamError: (listener) => { errors.add(listener); return () => errors.delete(listener) },
  }
  return { bridge, opens, closed, end: () => ends.forEach((listener) => listener({ streamId: "stream-1" })), fail: (message: string) => errors.forEach((listener) => listener({ streamId: "stream-1", message })), listeners: () => chunks.size + ends.size + errors.size }
}

async function settle() {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

test("named account events forward the replay cursor and receive synchronous first chunks", async () => {
  const harness = bridgeHarness()
  const response = accountEventResponse(harness.bridge, new Headers({ "Last-Event-ID": "evt-7" }), new AbortController().signal)
  const text = response.text()
  await settle()
  harness.end()
  expect(await text).toBe('data: {"type":"session.attention.raised"}\n\n')
  expect(harness.opens).toEqual([{ operation: "controlPlane.events", input: { lastEventId: "evt-7" } }])
  expect(harness.closed).toEqual(["stream-1"])
  expect(harness.listeners()).toBe(0)
})

test("account revocation surfaces as an auth error and disposes its stream listeners", async () => {
  const harness = bridgeHarness()
  const response = accountEventResponse(harness.bridge, new Headers(), new AbortController().signal)
  const text = response.text()
  await settle()
  harness.fail('HOSTED_HTTP 401 {"body":{"error":{"code":"invalid_bearer_token","message":"revoked"}}}')
  await expect(text).rejects.toMatchObject({ class: "auth", status: 401, code: "invalid_bearer_token" })
  expect(harness.listeners()).toBe(0)
})

test("disposal while main reserves a stream closes it once its identity arrives", async () => {
  const harness = bridgeHarness()
  let opened: (value: { streamId: string }) => void = () => undefined
  let starts = 0
  const bridge: HostedStreamBridge = {
    ...harness.bridge,
    streamOpen: () => new Promise((resolve) => { opened = resolve }),
    streamStart: async () => { starts++ },
  }
  const controller = new AbortController()
  const response = accountEventResponse(bridge, new Headers(), controller.signal)
  const text = response.text()
  controller.abort(new Error("scope disposed"))
  opened({ streamId: "reserved-late" })
  await expect(text).rejects.toThrow("scope disposed")
  await settle()
  expect(starts).toBe(0)
  expect(harness.closed).toEqual(["reserved-late"])
  expect(harness.listeners()).toBe(0)
})

test("a consumer cancelling its response closes the main stream without closing an already cancelled body", async () => {
  const harness = bridgeHarness()
  const response = accountEventResponse(harness.bridge, new Headers(), new AbortController().signal)
  await settle()
  await response.body!.cancel()
  expect(harness.closed).toEqual(["stream-1"])
  expect(harness.listeners()).toBe(0)
})
