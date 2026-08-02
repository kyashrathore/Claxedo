import { describe, expect, it } from "bun:test"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  type CompatEnvelope,
} from "../compat-events"
import {
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  type RuntimeSessionBusEvent,
} from "./service"

function adapter(input: {
  sendMessage?: AgentHarnessAdapter["sendMessage"]
  getMessages?: AgentHarnessAdapter["getMessages"]
  getSessionConfig?: AgentHarnessAdapter["getSessionConfig"]
}) {
  return {
    sendMessage: input.sendMessage ?? (async function* () {}) as AgentHarnessAdapter["sendMessage"],
    getMessages: input.getMessages ?? (async () => []),
    getSessionConfig: input.getSessionConfig ?? (async () => ({
      runner: { type: "opencode" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "default",
      agent: "build",
    })),
  } as unknown as AgentHarnessAdapter
}

describe("session service", () => {
  it("runs a prompt turn without a Hono route", async () => {
    const events: CompatEnvelope[] = []
    const statuses: RuntimeSessionBusEvent[] = []
    const turn = await runSessionPromptTurn({
      adapter: adapter({
        async *sendMessage(id, input, directory) {
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
          info: { id: "msg-user_r", role: "assistant" },
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
      publishStatus: (event) => statuses.push(event),
    })

    const output = sessionPromptReply(turn)

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.updated",
    ])
    expect(statuses).toEqual([
      { type: "process.status", directory: "/work", configId: "s1", status: "streaming" },
      { type: "process.status", directory: "/work", configId: "s1", status: "streaming" },
      { type: "process.status", directory: "/work", configId: "s1", status: "streaming" },
    ])
    expect(output.body).toEqual({
      info: { id: "msg-user_r", role: "assistant" },
      parts: [],
    })
    expect(output.assistantMessage).toBeUndefined()
  })

  it("does not synthesize prompt events when the adapter yields none", async () => {
    const events: CompatEnvelope[] = []

    await runSessionPromptTurn({
      adapter: adapter({}),
      sessionId: "s1",
      directory: "/work",
      body: {
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      },
      publishGlobal: (event) => events.push(event),
      publishStatus: () => {},
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
      publishStatus: () => {},
    })).rejects.toThrow("missing session")

    expect(returned).toBe(true)
    expect(events).toMatchObject([
      { directory: "/work", payload: { type: "session.error" } },
    ])
  })
})
