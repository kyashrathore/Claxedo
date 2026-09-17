import { describe, expect, it } from "bun:test"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { AgentRuntimeContractError, type AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  type CompatEnvelope,
} from "../compat-events"
import {
  admitSessionPromptTurn,
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  sessionTurnRefusal,
  type SessionPromptTurnInput,
} from "./service"

function adapter(input: {
  executeTurn?: NonNullable<AgentHarnessAdapter["executeTurn"]>
  getMessages?: AgentHarnessAdapter["getMessages"]
  getSessionConfig?: AgentHarnessAdapter["getSessionConfig"]
}) {
  return {
    instructionChannel: "turn-system-prompt",
    executeTurn: input.executeTurn ?? (async function* () {}) as NonNullable<AgentHarnessAdapter["executeTurn"]>,
    getMessages: input.getMessages ?? (async () => []),
    getSessionConfig: input.getSessionConfig ?? (async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "default",
      agent: "build",
    })),
  } as unknown as AgentHarnessAdapter
}

const executionBinding: AgentExecutionBinding = {
  sessionId: "s1",
  workspaceId: "workspace-test",
  directory: "/work",
  connectionId: "native:codex",
  upstreamSessionId: "s1",
}

/** The order every route uses: admit the turn, then run what admission produced. */
async function promptTurn(
  input: Omit<SessionPromptTurnInput, "admitted"> & { binding?: AgentExecutionBinding },
) {
  const { binding = executionBinding, ...rest } = input
  const admitted = await admitSessionPromptTurn({
    adapter: rest.adapter,
    binding,
    sessionId: rest.sessionId,
    directory: rest.directory,
    body: rest.body,
  })
  return runSessionPromptTurn({ ...rest, admitted })
}

describe("session service", () => {
  it("rejects a binding for another session before adapter execution", async () => {
    let executed = false
    const fixture = adapter({
      async *executeTurn() {
        executed = true
      },
    })

    await expect(promptTurn({
      adapter: fixture,
      binding: { ...executionBinding, sessionId: "another-session" },
      sessionId: "s1",
      directory: "/work",
      body: { parts: [] },
      publishGlobal: () => {},
    })).rejects.toThrow("execution binding sessionId mismatch")
    expect(executed).toBe(false)
  })

  it("refuses the turn with an upstream error when the session config cannot be read", async () => {
    let executed = false
    const fixture = adapter({
      getSessionConfig: async () => {
        throw new Error("session config store unreachable")
      },
      async *executeTurn() {
        executed = true
      },
    })

    const refusal = await promptTurn({
      adapter: fixture,
      binding: executionBinding,
      sessionId: "s1",
      directory: "/work",
      body: { parts: [], agent: "build", model: { providerID: "test", modelID: "fixture" }, variant: "fixture" },
      publishGlobal: () => {},
    }).then(() => undefined, (error: unknown) => error)

    expect(refusal).toBeInstanceOf(AgentRuntimeContractError)
    expect((refusal as AgentRuntimeContractError).detail).toEqual({
      code: "upstream_error",
      connectionId: "native:codex",
      message: "Session s1 configuration is unavailable, so its instructions cannot be applied: session config store unreachable",
    })
    // The refusal code is what frees the message id for a retry: without it the
    // failure is indistinguishable from one raised while the harness was running.
    expect(sessionTurnRefusal(refusal)).toBe("session_configuration_unavailable")
    expect(executed).toBe(false)
  })

  it("runs a prompt turn without a Hono route", async () => {
    const events: CompatEnvelope[] = []
    const turn = await promptTurn({
      binding: executionBinding,
      adapter: adapter({
        async *executeTurn(binding, input) {
          const id = binding.sessionId
          const directory = binding.directory
          yield messageUpdated(buildUserMessage({
            id: input.userMessageId!,
            sessionID: id,
            agent: input.agent,
            model: input.model,
          }))
          yield messagePartUpdated({
            id: "msg-user-part-0",
            sessionID: id,
            messageID: input.userMessageId!,
            type: "text",
            text: "hello",
          })
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: directory ?? "",
          }))
        },
        getMessages: async () => [{
          info: { id: "msg-user_r", sessionID: "s1", role: "assistant" },
          parts: [],
        }],
      }),
      sessionId: "s1",
      directory: "/work",
      body: {
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      },
      publishGlobal: (event) => events.push(event),
    })

    const output = sessionPromptReply(turn)

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.updated",
    ])
    expect(output.body).toEqual({
      info: { id: "msg-user_r", sessionID: "s1", role: "assistant" },
      parts: [],
    })
    expect(output.assistantMessage).toBeUndefined()
  })

  it("carries the requested permission mode into the adapter turn", async () => {
    const modes: Array<string | undefined> = []
    await promptTurn({
      binding: executionBinding,
      adapter: adapter({
        async *executeTurn(_binding, input) {
          modes.push(input.permissionMode)
        },
      }),
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }], permissionMode: "agent-full-access" },
      publishGlobal: () => {},
    })

    expect(modes).toEqual(["agent-full-access"])
  })

  it("uses the agent-owned default model when an ACP session has no selected model", async () => {
    const models: unknown[] = []
    await promptTurn({
      binding: executionBinding,
      adapter: adapter({
        getSessionConfig: async () => ({
          harness: { id: "openclaw", access: "connection" },
          variant: null,
          agent: null,
        }),
        async *executeTurn(_binding, input) {
          models.push(input.model)
        },
      }),
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text" as const, text: "hello" }] },
      publishGlobal: () => {},
    })

    expect(models).toEqual([{ providerID: "connection:openclaw", modelID: "default" }])
  })

  it("announces the reply row before the first part event on the runtime lane", async () => {
    const events: CompatEnvelope[] = []
    await runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async () => ({
            sessionId: "s1",
            userMessageId: "msg-user",
            assistantMessageId: "msg-user_r",
            directory: "/work",
            prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
            delivery: "start",
          }),
        },
        events: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              yield { payload: { type: "text-delta", delta: "hi" } }
              yield { payload: { type: "finish", reason: "stop" } }
            },
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }] },
      publishGlobal: (event) => events.push(event),
    })

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "message.completed",
      "session.idle",
    ])
    const announce = events[0]?.payload
    expect(announce?.type === "message.updated" && announce.properties.info.id === "msg-user_r" && announce.properties.info.parentID === "msg-user").toBe(true)
    if (announce?.type !== "message.updated") throw new Error("missing announce")
    // The announce stands in for the row turn admission publishes — the same
    // identity fields, so a merge cannot downgrade a populated row's chips.
    expect(announce.properties.info).toMatchObject({ agent: "build", modelID: "test", providerID: "test" })
  })

  it("carries the requested permission mode through the durable runtime turn", async () => {
    const starts: unknown[] = []
    await runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async (input: unknown) => {
            starts.push(input)
            return {
              sessionId: "s1",
              userMessageId: "msg-user",
              assistantMessageId: "msg-user_r",
              directory: "/work",
              prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
            }
          },
        },
        events: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {},
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "s1",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }], permissionMode: "agent-full-access" },
      publishGlobal: () => {},
    })

    expect(starts).toEqual([expect.objectContaining({ permissionMode: "agent-full-access" })])
  })

  it("forwards only a complete runtime actor pair", async () => {
    const starts: unknown[] = []
    const runtime = {
      turns: {
        start: async (input: unknown) => {
          starts.push(input)
          return {
            sessionId: "s1",
            userMessageId: "msg-user",
            assistantMessageId: "msg-user_r",
            directory: "/work",
            prompt: { parts: [], userMessageId: "msg-user", agent: "build", model: { providerID: "test", modelID: "test" } },
          }
        },
      },
      events: {
        subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
        list: async () => [],
      },
    } as never
    const common = {
      runtime,
      sessionId: "s1",
      directory: "/work" as const,
      body: { parts: [{ type: "text" as const, text: "hello" }] },
      publishGlobal: () => {},
    }

    await runRuntimePromptTurn({ ...common, actor: { actorId: "actor-1", actorKind: "human" } })
    await runRuntimePromptTurn(common)

    expect(starts[0]).toEqual(expect.objectContaining({ actorId: "actor-1", actorKind: "human" }))
    expect(starts[1]).not.toHaveProperty("actorId")
    expect(starts[1]).not.toHaveProperty("actorKind")
  })

  it("does not synthesize prompt events when the adapter yields none", async () => {
    const events: CompatEnvelope[] = []

    await promptTurn({
      binding: executionBinding,
      adapter: adapter({}),
      sessionId: "s1",
      directory: "/work",
      body: {
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      },
      publishGlobal: (event) => events.push(event),
      publishUserMessage: false,
    })

    expect(events).toEqual([])
  })

  it("closes runtime event streams when starting a turn fails", async () => {
    let returned = false
    const events: CompatEnvelope[] = []

    await expect(runRuntimePromptTurn({
      runtime: {
        turns: {
          start: async () => {
            throw new Error("missing session")
          },
        },
        events: {
          subscribe: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => ({ done: true as const, value: undefined }),
              return: async () => {
                returned = true
                return { done: true as const, value: undefined }
              },
            }),
          }),
          list: async () => [],
        },
      } as never,
      sessionId: "missing",
      directory: "/work",
      body: { parts: [{ type: "text", text: "hello" }] },
      publishGlobal: (event) => events.push(event),
    })).rejects.toThrow("missing session")

    expect(returned).toBe(true)
    expect(events).toMatchObject([
      { directory: "/work", payload: { type: "session.error" } },
    ])
  })

})
