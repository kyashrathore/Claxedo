import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { CompatEvent } from "../../compat-events"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import { createTurnEventProjector, type RuntimeAppendSource } from "./turn-projection"

const source: RuntimeAppendSource = {
  dir: "in",
  method: "test",
}

function projector(input: {
  appendEvent?: (event: CompatEvent) => { payload: CompatEvent } | void
  onAppend?: (event: { sessionId: string; agentSessionId?: string; payload: CompatEvent }) => void
  onEvent?: (event: CompatEvent) => void
  onRuntimeEvent?: (event: RuntimeEventEnvelopeInput) => void
  owner?: { sessionId: string; agentSessionId: string }
} = {}) {
  return createTurnEventProjector({
    store: {
      appendEvent(event) {
        input.onAppend?.(event)
        if (input.appendEvent) return input.appendEvent(event.payload) as { payload: CompatEvent }
        return { payload: event.payload }
      },
    },
    owner: {
      sessionId: input.owner?.sessionId ?? "session-1",
      getAgentSessionId: () => input.owner?.agentSessionId ?? "agent-session-1",
    },
    directory: "/repo",
    input: {
      userMessageId: "user-1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "default",
    },
    assistantMessageId: "assistant-1",
    created: 100,
    onEvent: input.onEvent ?? (() => {}),
    onRuntimeEvent: input.onRuntimeEvent,
  })
}

describe("createTurnEventProjector", () => {
  test("uses its explicit owner for compat storage, projection, and runtime publication", () => {
    const appended: Array<{ sessionId: string; agentSessionId?: string; payload: CompatEvent }> = []
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
    const compat: CompatEvent[] = []
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
    const compat: CompatEvent[] = []
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
    const compat: CompatEvent[] = []
    const committed = {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        partID: "part-1",
        field: "text",
        delta: "committed",
      },
    } as CompatEvent
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
        if (event.type !== "message.part.updated") return
        const part = event.properties.part as Record<string, unknown>
        if (part.type !== "tool") return
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
          } as CompatEvent,
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
})
