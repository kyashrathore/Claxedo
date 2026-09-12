import { describe, expect, test } from "bun:test"
import { createSessionRoutes } from "./session-core"
import type { AgentRuntime, AgentRuntimeTurnStartInput, PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { sessionIdle } from "../compat-events"

function adapter(): AgentHarnessAdapter {
  return {
    getSession: async (binding) => ({ id: binding.sessionId }),
    createSession: async () => ({ id: "session_1" }),
    updateSession: async (binding) => ({ id: binding.sessionId }),
    getSessionConfig: async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "test", modelID: "fixture" },
      agent: "build",
      variant: null,
    }),
    updateSessionConfig: async (_binding, patch) => ({
      harness: patch.harness ?? { id: "codex", access: "native" },
      agent: null,
      variant: null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({ harness: "codex", abort: true }) as never,
    executeTurn: () => (async function* () {})(),
    getMessages: async () => [],
    abort: async () => ({ ok: true, status: "cancelled" }),
    dispose: () => {},
  }
}

function runtimeDouble(input: {
  starts: AgentRuntimeTurnStartInput[]
  deliveries: PromptDelivery[]
  aborts?: Array<{ turnId?: string } | undefined>
  idle?: () => Promise<void>
}) {
  return {
    turns: {
      start: async (turn: AgentRuntimeTurnStartInput) => {
        input.starts.push(turn)
        const delivery = input.deliveries.shift() ?? "start"
        return {
          sessionId: turn.sessionId,
          userMessageId: turn.messageId ?? "user_1",
          assistantMessageId: "assistant_1",
          directory: undefined,
          delivery,
          prompt: {
            parts: turn.parts ?? [],
            userMessageId: turn.messageId ?? "user_1",
            assistantMessageId: "assistant_1",
            agent: "build",
            model: { providerID: "test", modelID: "fixture" },
          },
        }
      },
      whenIdle: async () => await (input.idle?.() ?? Promise.resolve()),
      abort: async (_sessionId: string, _directory: unknown, scope?: { turnId?: string }) => {
        input.aborts?.push(scope)
        return { ok: true, status: "cancelled" }
      },
    },
    events: {
      subscribe: () => (async function* () {
        yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
      })(),
      list: async () => [],
    },
  } as unknown as AgentRuntime
}

function routes(runtime: AgentRuntime) {
  return createSessionRoutes({
    resolveAdapter: () => adapter(),
    resolveRuntime: () => runtime,
    resolveDirectory: () => undefined,
    sessionBus: { publish: () => {}, subscribe: () => () => {} },
    publishGlobal: () => {},
  })
}

function prompt(body: Record<string, unknown>) {
  return { method: "POST", body: JSON.stringify(body) }
}

describe("how a prompt for a busy session is delivered", () => {
  test("a prompt asking to steer carries that to the runtime and answers with what happened", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const response = await routes(runtimeDouble({ starts, deliveries: ["steer"] }))
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_steer",
        parts: [{ type: "text", text: "also update the readme" }],
        delivery: "steer",
      }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "steer" })
    expect(starts.map((turn) => turn.delivery)).toEqual(["steer"])
  })

  test("a queued prompt is acknowledged as queued and started once the session frees up", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const response = await routes(runtimeDouble({
      starts,
      deliveries: ["queue", "start"],
      idle: () => idle,
    })).request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      delivery: "queue",
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "queue" })
    expect(starts).toHaveLength(1)
    release()
    for (let attempt = 0; attempt < 200 && starts.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts.map((turn) => turn.messageId)).toEqual(["msg_queued", "msg_queued"])
  })

  test("a prompt that asked nothing about delivery keeps the empty acknowledgement", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const response = await routes(runtimeDouble({ starts, deliveries: [] }))
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_plain",
        parts: [{ type: "text", text: "start the work" }],
      }))

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(starts.map((turn) => turn.delivery)).toEqual([undefined])
  })
})

describe("scoping Stop to a turn", () => {
  test("the turn the caller names reaches the runtime's abort", async () => {
    const aborts: Array<{ turnId?: string } | undefined> = []
    const response = await routes(runtimeDouble({ starts: [], deliveries: [], aborts }))
      .request("http://localhost/session/session_1/abort?turnId=msg_first", { method: "POST" })

    expect(response.status).toBe(200)
    expect(aborts).toEqual([{ turnId: "msg_first" }])
  })

  test("a Stop with no turn named still aborts whatever is running", async () => {
    const aborts: Array<{ turnId?: string } | undefined> = []
    const response = await routes(runtimeDouble({ starts: [], deliveries: [], aborts }))
      .request("http://localhost/session/session_1/abort", { method: "POST" })

    expect(response.status).toBe(200)
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toBeUndefined()
  })
})
