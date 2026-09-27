import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const snapshot: RuntimeSnapshot = {
  version: 4,
  mcp: {},
  connections: [],
  defaultHarness: { kind: "native", harnessId: "pi" },
  harnessLaunch: { pi: { agentDir: "/profiles/pi" } },
  auth: {
    pi: {
      baseUrl: "http://127.0.0.1:2595/bindings/pi1",
      placeholder: "placeholder",
      authMode: "bearer",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  },
}

type TurnEvents = (sessionId: string) => Array<Record<string, unknown>>

const answer: TurnEvents = (sessionId) => [
  { type: "text-delta", delta: "answer" },
  { type: "finish", sessionId },
]

async function fixture(turn = answer) {
  const directory = await mkdtemp(join(tmpdir(), "prompt-ids-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws_ids", directory }
  const adapter = {
    adapterCapabilities: ["runtime-config"] as const,
    setModel() {},
    async applyConfig() {},
    sessionConfigOwner: "runtime" as const,
    async createSession(_directory: string, _title: string | undefined, id?: string) {
      return { id: id ?? "generated", agentSessionId: `upstream-${id}` }
    },
    async getSession() { return null },
    async getMessages() { return [] },
    async updateSession() { return null },
    async deleteSession() {},
    async getSessionConfig() { throw new Error("runtime-owned config") },
    async updateSessionConfig() { throw new Error("runtime-owned config") },
    readHarnessCapabilities: () => ({
      abort: false, reconnect: false, replay: true, permissions: false, questions: false,
      todos: false, commands: false, fork: false, revert: false, unrevert: false,
      configOptions: false, subagents: false, goals: false, harness: "pi",
    }),
    async *executeTurn(binding: { sessionId: string }) {
      yield* turn(binding.sessionId)
    },
    dispose() {},
  } as unknown as AgentHarnessAdapter
  const host = createWorkspaceHost({
    target,
    storeRoot: join(directory, "state"),
    harnesses: [{ match: (runner: { id: string }) => runner.id === "pi", create: () => adapter }],
  } as never)
  cleanups.push(() => host.dispose())
  await host.apply(snapshot)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
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
  return { request, transcript }
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
