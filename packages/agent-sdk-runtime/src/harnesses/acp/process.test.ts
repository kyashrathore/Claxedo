import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type PromptRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import { ACPProcess, acpClientCapabilities } from "./process"

test("advertises implemented ACP capabilities and the versioned child-session extension", () => {
  const expected = {
    auth: { terminal: false },
    fs: { readTextFile: true, writeTextFile: true },
    plan: {},
    terminal: true,
    elicitation: { form: {}, url: {} },
    subagents: {},
    _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
  }
  expect(acpClientCapabilities()).toEqual(expected)
})

/**
 * A real ACP agent on the far end of an in-memory pipe, so the timers under
 * test run against the same JSON-RPC traffic a spawned binary produces. Only
 * `prompt` is scripted per test.
 */
function fakeAgent(prompt: (conn: AgentSideConnection, params: PromptRequest) => Promise<{ stopReason: "end_turn" }>) {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const cancelled: string[] = []
  const agent = new AgentSideConnection(
    (conn): Agent => ({
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {} }
      },
      async newSession() {
        return { sessionId: "agent-session-1" }
      },
      async authenticate() {},
      prompt: (params) => prompt(conn, params),
      async cancel(params) {
        cancelled.push(params.sessionId)
      },
    }),
    ndJsonStream(toClient.writable, toAgent.readable),
  )
  const clientStream = ndJsonStream(toAgent.writable, toClient.readable)
  return { agent, cancelled, clientStream }
}

function textUpdate(conn: AgentSideConnection, sessionId: string, text: string) {
  return conn.sessionUpdate({
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ACPProcess.prompt quiet countdown", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-process-"))
  const prevTimeout = process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
  const prevCancelTimeout = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  const procs: ACPProcess[] = []

  beforeEach(() => {
    process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = "200"
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "100"
  })

  afterEach(() => {
    for (const proc of procs.splice(0)) proc.dispose()
    if (prevTimeout === undefined) delete process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = prevTimeout
    if (prevCancelTimeout === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prevCancelTimeout
  })

  async function connected(prompt: Parameters<typeof fakeAgent>[0]) {
    const fake = fakeAgent(prompt)
    const proc = new ACPProcess(
      directory,
      "fake-acp",
      [],
      "default",
      () => [],
      () => {},
      () => ({
        kind: "stdio",
        stream: fake.clientStream,
        metadata: {},
        pid: 1,
        alive: true,
        dispose() {},
      }),
      () => ({}),
    )
    procs.push(proc)
    await proc.initialize()
    const sessionId = await proc.newSession(directory)
    return { proc, sessionId, fake }
  }

  const input = { parts: [{ type: "text", text: "hello" }], system: undefined } as unknown as Parameters<ACPProcess["prompt"]>[1]

  test("a turn longer than the countdown survives while the agent keeps streaming", async () => {
    const { proc, sessionId } = await connected(async (conn, params) => {
      for (let index = 0; index < 8; index += 1) {
        await sleep(60)
        await textUpdate(conn, params.sessionId, `chunk ${index}`)
      }
      return { stopReason: "end_turn" }
    })
    const updates: string[] = []
    const started = Date.now()
    const result = await proc.prompt(sessionId, input, (update) => updates.push(update.sessionUpdate), directory)
    expect(result.stopReason).toBe("end_turn")
    expect(Date.now() - started).toBeGreaterThan(400)
    expect(updates).toHaveLength(8)
  })

  test("a permission left with the human holds the countdown open", async () => {
    let answered: RequestPermissionResponse | undefined
    const { proc, sessionId } = await connected(async (conn, params) => {
      answered = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call-1", title: "bun test", kind: "execute" },
        options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
      })
      return { stopReason: "end_turn" }
    })
    const pushed: string[] = []
    proc.permissionPushers.set(sessionId, ({ permId }) => pushed.push(permId))
    const turn = proc.prompt(sessionId, input, () => {}, directory)
    await sleep(600)
    expect(pushed).toHaveLength(1)
    proc.respondPermission(pushed[0] ?? "", { outcome: { outcome: "selected", optionId: "once" } })
    const result = await turn
    expect(result.stopReason).toBe("end_turn")
    expect(answered).toEqual({ outcome: { outcome: "selected", optionId: "once" } })
  })

  test("a session waiting for permission does not block another session or accept a second prompt of its own", async () => {
    const { proc, sessionId } = await connected(async (conn, params) => {
      if (params.sessionId === sessionId) {
        await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: "held", title: "bun test", kind: "execute" },
          options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
        })
      }
      await textUpdate(conn, params.sessionId, params.sessionId)
      return { stopReason: "end_turn" }
    })
    const first: string[] = []
    const second: string[] = []
    const turn = proc.prompt(sessionId, input, (u) => first.push(u.sessionUpdate), directory)
    await expect(proc.prompt(sessionId, input, () => {}, directory)).rejects.toThrow("already has an active prompt")
    await proc.prompt("other-session", input, (u) => second.push(u.sessionUpdate), directory)
    expect(first).toEqual([])
    expect(second).toEqual(["agent_message_chunk"])
    const permission = [...proc.pendingPermissions.keys()][0]
    proc.respondPermission(permission, { outcome: { outcome: "selected", optionId: "once" } })
    await turn
    expect(first).toEqual(["agent_message_chunk"])
  })

  test("a pusher that answers on the spot releases the hold, so silence afterwards still times out", async () => {
    const { proc, sessionId } = await connected(async (conn, params) => {
      await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call-1", title: "bun test", kind: "execute" },
        options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
      })
      return new Promise(() => {})
    })
    proc.permissionPushers.set(sessionId, ({ permId }) => {
      proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: "once" } })
    })
    const started = Date.now()
    let markUncertain!: () => void
    const uncertain = new Promise<void>((resolve) => { markUncertain = resolve })
    const turn = proc.prompt(sessionId, input, () => {}, directory, markUncertain)
    const rejected = turn.then(() => undefined, (error: Error) => error)
    await uncertain
    expect(proc.sessionListeners.has(sessionId)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    proc.dispose("test shutdown")
    expect((await rejected)?.message).toContain("ACP process replaced")
  }, 3_000)

  test("silence requests cancellation while preserving the unresolved turn", async () => {
    const { proc, sessionId, fake } = await connected(() => new Promise(() => {}))
    const started = Date.now()
    let markUncertain!: () => void
    const uncertain = new Promise<void>((resolve) => { markUncertain = resolve })
    const turn = proc.prompt(sessionId, input, () => {}, directory, markUncertain)
    const rejected = turn.then(() => undefined, (error: Error) => error)
    await uncertain
    expect(proc.sessionListeners.has(sessionId)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    await sleep(20)
    expect(fake.cancelled).toEqual([sessionId])
    await expect(proc.prompt(sessionId, input, () => {}, directory)).rejects.toThrow("outcome is uncertain")
    proc.dispose("test shutdown")
    expect((await rejected)?.message).toContain("ACP process replaced")
  })

  test("a disposal reason reaches the prompt still in flight", async () => {
    const { proc, sessionId } = await connected(() => new Promise(() => {}))
    const turn = proc.prompt(sessionId, input, () => {}, directory)
    await sleep(10)
    proc.dispose("ACP prompt timed out after 200ms of inactivity")
    await expect(turn).rejects.toThrow("ACP process replaced: ACP prompt timed out after 200ms of inactivity")
  })
})
