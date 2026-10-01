import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { RuntimeEventEnvelopeInput } from "./runtime-event-hub"
import type { RuntimeAppendSource } from "./session-event-writer"
import { testTurnProjector } from "../test-support/turn-projector"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openRuntimeStore } from "../store-file"
import { createTurnEventProjector } from "./turn-projection"
import { AgentRuntimeStaleTurnError } from "../store"

const source: RuntimeAppendSource = {
  dir: "in",
  method: "test",
}

function projector(input: {
  appendEvent?: (event: AgentPresentationEvent) => { payload: AgentPresentationEvent } | void
  onAppend?: (event: { sessionId: string; agentSessionId?: string; payload: AgentPresentationEvent }) => void
  onEvent?: (event: AgentPresentationEvent) => void
  onRuntimeEvent?: (event: RuntimeEventEnvelopeInput) => void
  owner?: { sessionId: string; agentSessionId: string }
} = {}) {
  return testTurnProjector({
    appendEvent(event) {
      input.onAppend?.(event)
      if (input.appendEvent) return input.appendEvent(event.payload) as { payload: AgentPresentationEvent }
      return { payload: event.payload }
    },
    ...(input.owner ? { owner: { sessionId: input.owner.sessionId, getAgentSessionId: () => input.owner!.agentSessionId } } : {}),
    input: { userMessageId: "user-1", agent: "general", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" }, variant: "default" },
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.onRuntimeEvent ? { onRuntimeEvent: input.onRuntimeEvent } : {}),
  })
}

describe("createTurnEventProjector", () => {
  test("a subagent revision commits to the real journal before runtime publication", () => {
    const root = mkdtempSync(path.join(tmpdir(), "turn-event-writer-"))
    const store = openRuntimeStore(root)
    try {
      store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s", directory: "/work", agentSessionId: "agent", createdAt: 1 })
      const initialOrdinal = store.getSessionMaxSeq("s")
      const published: AgentPresentationEvent[] = []
      const runtimeOrdinals: number[] = []
      const item = createTurnEventProjector({
        store, owner: { sessionId: "s", getAgentSessionId: () => "agent" }, directory: "/work",
        input: { userMessageId: "u", agent: "general" }, assistantMessageId: "u_r", created: 1,
        onEvent: (event) => published.push(event),
        onRuntimeEvent: () => runtimeOrdinals.push(store.getSessionMaxSeq("s")),
      })
      item.project({ type: "subagent-updated", subagentKey: "child", revision: 1, status: "running" }, source)
      expect(runtimeOrdinals).toEqual([initialOrdinal + 1])
      expect(published.map((event) => event.type)).toEqual(["subagent.updated"])
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("real journal writes retain the fence and publish derived usage only after commit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "turn-event-fence-"))
    const store = openRuntimeStore(root)
    try {
      store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s", directory: "/work", agentSessionId: "agent", createdAt: 1 })
      const start = (id: string, fencingToken: number) => store.startTurn({
        sessionId: "s", agentSessionId: "agent", userMessageId: id, assistantMessageId: `${id}_r`,
        agent: "general", model: { providerID: "test", modelID: "model" }, parts: [{ type: "text", text: "work" }], fencingToken,
      })
      start("u", 4)
      const initialOrdinal = store.getSessionMaxSeq("s")
      const published: AgentPresentationEvent[] = []
      const runtimeOrdinals: number[] = []
      const item = createTurnEventProjector({
        store, owner: { sessionId: "s", getAgentSessionId: () => "agent" }, directory: "/work",
        input: { userMessageId: "u", agent: "general" }, assistantMessageId: "u_r", created: 1, fencingToken: 4,
        onEvent: (event) => {
          expect(store.getSessionMaxSeq("s")).toBe(initialOrdinal + 1)
          published.push(event)
        },
        onRuntimeEvent: () => runtimeOrdinals.push(store.getSessionMaxSeq("s")),
      })
      item.project({ type: "usage", contextSize: 100, contextUsed: 10,
        observation: { kind: "cumulative", tokens: { input: 7, output: 2, reasoning: null, cache: { read: null, write: null } } } }, source)
      expect(published.map((event) => event.type)).toEqual(["session.usage", "message.updated"])
      expect(published[1]).toMatchObject({ properties: { info: { id: "u_r", tokens: { input: 7, output: 2 } } } })
      expect(runtimeOrdinals).toEqual([initialOrdinal + 1])
      start("new", 5)
      const takeoverOrdinal = store.getSessionMaxSeq("s")
      published.length = 0
      runtimeOrdinals.length = 0
      expect(() => item.project({ type: "text-delta", delta: "stale" }, source)).toThrow(AgentRuntimeStaleTurnError)
      expect(store.getSessionMaxSeq("s")).toBe(takeoverOrdinal)
      expect(published).toEqual([])
      expect(runtimeOrdinals).toEqual([])
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("uses its explicit owner for compat storage, projection, and runtime publication", () => {
    const appended: Array<{ sessionId: string; agentSessionId?: string; payload: AgentPresentationEvent }> = []
    const runtime: RuntimeEventEnvelopeInput[] = []
    const item = projector({
      owner: { sessionId: "child-1", agentSessionId: "provider-child-1" },
      onAppend: (event) => appended.push(event),
      onRuntimeEvent: (event) => runtime.push(event),
    })

    item.project({ type: "text-delta", delta: "child text" }, source)
    item.project({ type: "step-start", newMessageId: "child-assistant-2" }, source)
    item.project({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" }, source)
    item.terminalizeOpenTools("failed", source)

    expect(appended.length).toBeGreaterThan(0)
    expect(appended.every((event) =>
      event.sessionId === "child-1" && event.agentSessionId === "provider-child-1"
    )).toBe(true)
    expect(appended.some((event) =>
      event.payload.type === "message.updated" &&
      event.payload.properties.info.sessionID === "child-1"
    )).toBe(true)
    expect(runtime.length).toBeGreaterThan(0)
    expect(runtime.every((event) =>
      event.sessionId === "child-1" && event.agentSessionId === "provider-child-1"
    )).toBe(true)
  })

  test("does not publish runtime events when compat append fails", () => {
    const runtime: RuntimeEventEnvelopeInput[] = []
    const compat: AgentPresentationEvent[] = []
    const item = projector({
      appendEvent() {
        throw new Error("append failed")
      },
      onEvent: (event) => compat.push(event),
      onRuntimeEvent: (event) => runtime.push(event),
    })

    expect(() => item.project({ type: "text-delta", delta: "hello" }, source)).toThrow("append failed")
    expect(compat).toEqual([])
    expect(runtime).toEqual([])
  })

  test("does not publish live events when compat append does not return committed output", () => {
    const runtime: RuntimeEventEnvelopeInput[] = []
    const compat: AgentPresentationEvent[] = []
    const item = projector({
      appendEvent() {
        return undefined
      },
      onEvent: (event) => compat.push(event),
      onRuntimeEvent: (event) => runtime.push(event),
    })

    expect(() => item.project({ type: "text-delta", delta: "hello" }, source)).toThrow("committed output")
    expect(compat).toEqual([])
    expect(runtime).toEqual([])
  })

  test("publishes runtime events after compat output is appended", () => {
    const order: string[] = []
    const item = projector({
      appendEvent: (event) => {
        order.push(`append:${event.type}`)
        return { payload: event }
      },
      onEvent: (event) => order.push(`compat:${event.type}`),
      onRuntimeEvent: (event) => order.push(`runtime:${event.payload.type}`),
    })

    item.project({ type: "text-delta", delta: "hello" }, source)

    expect(order).toEqual([
      "append:message.part.updated",
      "compat:message.part.updated",
      "append:message.part.delta",
      "compat:message.part.delta",
      "runtime:text-delta",
    ])
  })

  test("publishes compatibility output from committed append results", () => {
    const compat: AgentPresentationEvent[] = []
    const committed = {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "part-1",
        field: "text",
        delta: "committed",
      },
    } as AgentPresentationEvent
    const item = projector({
      appendEvent: (event) => event.type === "message.part.delta" ? { payload: committed } : { payload: event },
      onEvent: (event) => compat.push(event),
    })

    item.project({ type: "text-delta", delta: "memory" }, source)

    expect(compat).toContain(committed)
    expect(compat.some((event) =>
      event.type === "message.part.delta" &&
      (event.properties as { delta?: string }).delta === "memory"
    )).toBe(false)
  })

  test("uses a stable runtime projection key across step-start", () => {
    const runtime: RuntimeEventEnvelopeInput[] = []
    const item = projector({
      onRuntimeEvent: (event) => runtime.push(event),
    })

    item.project({ type: "step-start", newMessageId: "assistant-2" }, source)
    item.project({ type: "text-delta", delta: "after step" }, source)

    expect(item.assistantMessageId()).toBe("assistant-2")
    expect(runtime.map((event) => event.assistantMessageId)).toEqual([
      "assistant-1",
      "assistant-1",
    ])
  })

  test("publishes terminalized tool errors to runtime subscribers after append", () => {
    const runtime: AgentRuntimeEvent[] = []
    const item = projector({
      onRuntimeEvent: (event) => runtime.push(event.payload),
    })

    item.project({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" }, source)
    runtime.length = 0
    const compat = item.terminalizeOpenTools("prompt failed", source)

    expect(compat.map((event) => event.type)).toContain("message.part.updated")
    expect(runtime).toContainEqual({
      type: "tool-error",
      toolCallId: "tool-1",
      error: "prompt failed",
    })
  })

  test("terminalized tool output uses the committed append payload", () => {
    const committedError = "committed failure"
    const runtime: AgentRuntimeEvent[] = []
    const item = projector({
      appendEvent(event) {
        if (event.type !== "message.part.updated") return undefined
        const part = event.properties.part as Record<string, unknown>
        if (part.type !== "tool") return undefined
        return {
          payload: {
            ...event,
            properties: {
              ...event.properties,
              part: {
                ...part,
                state: {
                  ...(part.state as Record<string, unknown>),
                  error: committedError,
                },
              },
            },
          } as AgentPresentationEvent,
        }
      },
      onRuntimeEvent: (event) => runtime.push(event.payload),
    })

    item.project({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" }, source)
    runtime.length = 0
    const compat = item.terminalizeOpenTools("prompt failed", source)

    expect(compat.some((event) =>
      event.type === "message.part.updated" &&
      ((event.properties.part as Record<string, unknown>).state as Record<string, unknown>).error === committedError
    )).toBe(true)
    expect(runtime).toContainEqual({
      type: "tool-error",
      toolCallId: "tool-1",
      error: committedError,
    })
  })

  test("does not publish terminalized tool errors when append fails", () => {
    const runtime: AgentRuntimeEvent[] = []
    let fail = false
    const item = projector({
      appendEvent(event) {
        if (fail && event.type === "message.part.updated") throw new Error("append failed")
        return { payload: event }
      },
      onRuntimeEvent: (event) => runtime.push(event.payload),
    })

    item.project({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" }, source)
    runtime.length = 0
    fail = true

    expect(() => item.terminalizeOpenTools("prompt failed", source)).toThrow("append failed")
    expect(runtime).toEqual([])
  })

  test("a steered prompt is written with its own author and parts, and each is taken in once", () => {
    const appended: AgentPresentationEvent[] = []
    const steered = new Map([["msg_steer", {
      userMessageId: "msg_steer", agent: "build", parts: [{ type: "text" as const, text: "show me with html" }],
      author: { id: "user-2", name: "Asha", kind: "human" as const },
    }]])
    const item = testTurnProjector({
      appendEvent: (event) => { appended.push(event.payload); return { payload: event.payload } },
      takeSteeredInput: (messageId) => { const input = steered.get(messageId); steered.delete(messageId); return input },
    })

    item.project({ type: "input-incorporated", messageId: "msg_steer" }, source)
    const user = appended.find((event) => event.type === "message.updated" && event.properties.info.role === "user")
    expect(user?.type === "message.updated" && user.properties.info).toMatchObject({ id: "msg_steer", agent: "build" })
    expect(JSON.stringify(user)).toContain("Asha")
    expect(appended.filter((event) => event.type === "message.part.updated").map((event) =>
      event.type === "message.part.updated" && event.properties.part)).toEqual([
      expect.objectContaining({ messageID: "msg_steer", type: "text", text: "show me with html" }),
    ])
    expect(item.assistantMessageId()).toBe("msg_steer_r")

    appended.length = 0
    item.project({ type: "input-incorporated", messageId: "msg_steer" }, source)
    expect(appended.map((event) => event.type)).toEqual(["runtime.diagnostic"])
    expect(item.assistantMessageId()).toBe("msg_steer_r")
  })
})
