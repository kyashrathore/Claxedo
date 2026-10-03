import { expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { authorizedSessionNotices } from "./authorized-session-notices"

const auth = { mode: "signed", principal: { userId: "reader" } } as SignedControlPlaneAuth
const privateFrame = { type: "session.status.changed", ownerUserId: "reader", sessionId: "ses", workspaceId: "ws", projectId: "prj", title: "Secret title" }
const wire = (payload: unknown, id: string) => `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`
const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })

test("checks each queued live and replay notice against current access, retaining denied cursors only", async () => {
  const visible = vi.fn(async () => false)
  const output = await authorizedSessionNotices(response(wire({ ...privateFrame, replayed: true }, "6") + wire(privateFrame, "7")), { auth, visible }).text()
  expect(output).toBe(wire({ type: "heartbeat" }, "6") + wire({ type: "heartbeat" }, "7"))
  expect(output).not.toContain("Secret title")
  expect(visible).toHaveBeenCalledTimes(2)
  expect(visible).toHaveBeenCalledWith(auth, { sessionId: "ses", workspaceId: "ws" }, "session.status.changed")
})

test("preserves allowed frames, applies read policy to nested envelopes and independently validates recipients", async () => {
  const allowed = wire({ replayed: true, payload: privateFrame }, "3")
  const denied = wire({ frame: { ...privateFrame, ownerUserId: "someone-else" } }, "4")
  const visible = vi.fn(async () => true)
  const output = await authorizedSessionNotices(response(allowed + denied), { auth, visible }).text()
  expect(output).toBe(allowed + wire({ type: "heartbeat" }, "4"))
  expect(visible).toHaveBeenCalledTimes(1)
  expect(await authorizedSessionNotices(response(wire(privateFrame, "5")), { auth }).text()).toBe(wire({ type: "heartbeat" }, "5"))
})

test("processes chunked UTF-8 and SSE line endings without reordering async permission reads", async () => {
  const input = wire({ ...privateFrame, title: "工程 review" }, "1").replaceAll("\n", "\r\n") + wire({ type: "heartbeat" }, "2")
  const bytes = new TextEncoder().encode(input)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) return controller.close()
    controller.enqueue(bytes.slice(offset, ++offset))
  } })
  const output = await authorizedSessionNotices(new Response(body), { auth, visible: async () => true }).text()
  expect(output).toBe(wire({ ...privateFrame, title: "工程 review" }, "1") + wire({ type: "heartbeat" }, "2"))
})

test("closes on authority failures and bounded malformed source data without forwarding its payload", async () => {
  await expect(authorizedSessionNotices(response(wire(privateFrame, "2")), {
    auth, visible: async () => { throw new Error("Authority unavailable") },
  }).text()).rejects.toThrow("Authority unavailable")
  await expect(authorizedSessionNotices(response(`data: ${"x".repeat(65 * 1024)}\n\n`), { auth }).text()).rejects.toThrow("byte limit")
  await expect(authorizedSessionNotices(response('data: {"type":"heartbeat"}'), { auth }).text()).rejects.toThrow("incomplete frame")
})

test("the tombstone exception admits only a minimal removal payload and strips arbitrary content", async () => {
  const input = { ...privateFrame, type: "session.removed", ts: 10, body: "Secret transcript", replayed: true }
  const visible = vi.fn(async () => true)
  const output = await authorizedSessionNotices(response(wire({ payload: input, data: "Private extra" }, "10")), { auth, visible }).text()
  const payload = JSON.parse(output.split("data: ")[1])
  expect(payload).toEqual({ type: "session.removed", ownerUserId: "reader", sessionId: "ses", workspaceId: "ws", projectId: "prj", ts: 10, replayed: true })
  expect(output).not.toContain("Secret")
  expect(output).not.toContain("Private")
  expect(visible).toHaveBeenCalledWith(auth, { sessionId: "ses", workspaceId: "ws" }, "session.removed")
  expect(output.startsWith("id: 10\n")).toBe(true)
})
