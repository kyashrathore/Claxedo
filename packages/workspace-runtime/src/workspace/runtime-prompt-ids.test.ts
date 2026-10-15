import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const snapshot: RuntimeSnapshot = {
  version: 4, commands: [], mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } },
  connections: [{ connectionId: "scripted", providerKey: "scripted", configRevision: 1, enabled: true, config: {} }],
  defaultHarness: { kind: "connection", connectionId: "scripted" },
}

type TurnEvents = (sessionId: string) => AgentRuntimeEvent[]

const answer: TurnEvents = (sessionId) => [
  { type: "text-delta", delta: "answer" },
  { type: "finish", sessionId },
]

async function fixture(turn = answer) {
  const directory = await mkdtemp(join(tmpdir(), "prompt-ids-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws_ids", directory }
  const provider = fakeConnectionProvider({
    providerKey: "scripted",
    transport: () => new FakeTransport({
      turn: async function* ({ session }) { yield* turn(session.binding.sessionId) },
    }),
  })
  const boot = async () => {
    const host = createWorkspaceHost({
      sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "state"), connectionProviders: [provider] })
    await host.apply(snapshot)
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
    return { host, app }
  }
  let running = await boot()
  cleanups.push(() => running.host.dispose())
  const restart = async () => {
    await running.host.dispose()
    running = await boot()
  }
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => running.app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  const transcript = async (sessionId: string) => {
    const response = await request(`/session/${sessionId}/message`)
    expect(response.status).toBe(200)
    const messages = await response.json() as Array<{ info: { id: string; sessionID: string }; parts: Array<{ id: string; messageID: string; sessionID: string; type: string; text?: string }> }>
    return messages.map((message) => ({
      id: message.info.id,
      sessionID: message.info.sessionID,
      parts: message.parts.map((part) => ({ id: part.id, messageID: part.messageID, sessionID: part.sessionID, text: part.text })),
    }))
  }
  for (const id of ["a", "b"]) expect((await request("/session", "POST", { id })).status).toBe(201)
  expect((await request("/session/a/message", "POST", {
    messageID: "msg_a",
    parts: [{ id: "prt_a", type: "text", text: "mine" }],
  })).status).toBe(200)
  return { request, transcript, restart }
}

test.each(["/message", "/prompt_async"])("a %s prompt naming another session's message id is refused and moves none of its rows", async (route) => {
  const f = await fixture()
  const before = await f.transcript("a")

  const response = await f.request(`/session/b${route}`, "POST", {
    messageID: "msg_a",
    parts: [{ id: "prt_a", type: "text", text: "stolen" }],
  })

  expect(response.status).toBe(409)
  expect((await response.json() as { error: { code: string } }).error.code).toBe("message_id_conflict")
  expect(await f.transcript("a")).toEqual(before)
  expect(await f.transcript("b")).toEqual([])
})

test.each(["queue", "steer"])("a prompt delivered by %s naming another session's message id is refused at admission and queues nothing", async (delivery) => {
  const f = await fixture()
  const before = await f.transcript("a")

  const response = await f.request("/session/b/prompt_async", "POST", {
    messageID: "msg_a",
    delivery,
    parts: [{ type: "text", text: "stolen" }],
  })

  expect(response.status).toBe(409)
  expect((await response.json() as { error: { code: string } }).error.code).toBe("message_id_conflict")
  expect(await (await f.request("/session/b/queue")).json()).toEqual([])
  expect(await f.transcript("a")).toEqual(before)
  expect(await f.transcript("b")).toEqual([])
})

test("a prompt's part ids are minted from its message id, so a client part id cannot reach another session's part", async () => {
  const f = await fixture()
  const before = await f.transcript("a")

  expect((await f.request("/session/b/message", "POST", {
    messageID: "msg_b",
    parts: [{ id: "prt_a", type: "text", text: "stolen" }, { type: "text", text: "second" }],
  })).status).toBe(200)

  expect(await f.transcript("a")).toEqual(before)
  expect((await f.transcript("b"))[0]).toEqual({
    id: "msg_b",
    sessionID: "b",
    parts: [
      { id: "msg_b-part-0", messageID: "msg_b", sessionID: "b", text: "stolen" },
      { id: "msg_b-part-1", messageID: "msg_b", sessionID: "b", text: "second" },
    ],
  })
})

test("resubmitting a message id in its own session reruns the turn", async () => {
  const f = await fixture()

  expect((await f.request("/session/a/message", "POST", {
    messageID: "msg_a",
    parts: [{ type: "text", text: "again" }],
  })).status).toBe(200)

  expect((await f.transcript("a")).find((message) => message.id === "msg_a")?.parts).toEqual([
    { id: "msg_a-part-0", messageID: "msg_a", sessionID: "a", text: "again" },
  ])
})

test("a prompt_async under a message id its session already holds answers as the first did and starts no second turn, after the runtime restarted too", async () => {
  let turns = 0
  const f = await fixture((sessionId) => {
    turns += 1
    return answer(sessionId)
  })
  const sent = { messageID: "msg_lost_ack", parts: [{ type: "text", text: "once" }] }
  const settled = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await Bun.sleep(10)
      const status = await (await f.request("/session/status")).json() as Record<string, { type: string } | undefined>
      if (status.a?.type !== "busy") return
    }
  }

  expect((await f.request("/session/a/prompt_async", "POST", sent)).status).toBe(204)
  await settled()
  expect(turns).toBe(2)

  expect((await f.request("/session/a/prompt_async", "POST", sent)).status).toBe(204)
  await f.restart()
  expect((await f.request("/session/a/prompt_async", "POST", sent)).status).toBe(204)
  await settled()

  expect(turns).toBe(2)
  expect((await f.transcript("a")).filter((message) => message.id === "msg_lost_ack")).toHaveLength(1)
})

test("two sessions whose harness reuses a tool-call id each keep their own tool part", async () => {
  const f = await fixture((sessionId) => [
    { type: "text-delta", delta: "answer" },
    { type: "tool-start", toolCallId: "call_1", toolName: "bash" },
    { type: "tool-output", toolCallId: "call_1", output: `ran in ${sessionId}` },
    { type: "tool-status", toolCallId: "call_1", status: "completed" },
    { type: "finish", sessionId },
  ])
  const before = await f.transcript("a")
  expect(before.flatMap((message) => message.parts)).toHaveLength(3)

  expect((await f.request("/session/b/message", "POST", {
    messageID: "msg_b",
    parts: [{ type: "text", text: "go" }],
  })).status).toBe(200)

  expect(await f.transcript("a")).toEqual(before)
  expect((await f.transcript("b")).flatMap((message) => message.parts)).toHaveLength(3)
})
