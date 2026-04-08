import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  messagePartUpdated,
  messagePartDelta,
  permissionAsked,
  questionAsked,
  sessionIdle,
  todoUpdated,
} from "./compat-events"
import { RuntimeStore } from "./store"

const roots: string[] = []

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-"))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe("RuntimeStore", () => {
  it("replays journaled messages and todos", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartDelta({
        sessionID: "s1",
        messageID: "m1",
        partID: "m1-text",
        field: "text",
        delta: "world",
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ content: "Ship", status: "pending", priority: "high" }]),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionIdle("s1"),
    })

    const next = new RuntimeStore(root)
    const msgs = next.getMessages("s1") as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>

    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.info.role).toBe("user")
    expect(msgs[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" })
    expect(msgs[1]?.info.role).toBe("assistant")
    expect(msgs[1]?.parts[0]).toMatchObject({ type: "text", text: "world" })
    expect(next.getTodos("s1")).toEqual([{ content: "Ship", status: "pending", priority: "high" }])
  })

  it("preserves agent_session_id through status updates", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "agent-abc",
      createdAt: 1,
    })

    // agent_session_id is present after bind
    expect(store.getAgentSessionId("s1")).toBe("agent-abc")

    // startTurn calls upsertSession without agentSessionId — must not clear it
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    expect(store.getAgentSessionId("s1")).toBe("agent-abc")

    // session.idle event also must not clear it
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      payload: sessionIdle("s1"),
    })
    expect(store.getAgentSessionId("s1")).toBe("agent-abc")

    // Replay also preserves it
    const next = new RuntimeStore(root)
    expect(next.getAgentSessionId("s1")).toBe("agent-abc")
  })

  it("marks pending interactives stale after process loss", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp"],
        metadata: {},
        always: ["/tmp"],
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [{
          question: "Ship it?",
          header: "Ship it?",
          options: [{ label: "Yes", description: "Ship it" }],
          custom: false,
        }],
      }),
    })
    first.processLost("/work", "ACP process restarted")

    const next = new RuntimeStore(root)
    expect(next.listPermissions("/work")).toEqual([])
    expect(next.getSession("s1")).toMatchObject({ status: "error" })
    expect(next.consumeRecoveryError("s1")).toBe("ACP process restarted")
    expect(next.consumeRecoveryError("s1")).toBeNull()
  })

  it("terminalizes running tool parts after process loss", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "task",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })

    first.processLost("/work", "ACP process restarted; pending interactive state must be rerun")

    const current = first.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    expect(current[1]?.parts.find((part) => part.id === "tool-1")).toMatchObject({
      id: "tool-1",
      type: "tool",
      state: {
        status: "error",
        error: "Tool execution interrupted by ACP restart",
      },
    })

    const next = new RuntimeStore(root)
    const replayed = next.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    expect(replayed[1]?.parts.find((part) => part.id === "tool-1")).toMatchObject({
      id: "tool-1",
      type: "tool",
      state: {
        status: "error",
        error: "Tool execution interrupted by ACP restart",
      },
    })
    expect(next.getSession("s1")).toMatchObject({ status: "recovering" })
  })

  it("returns normalized session objects from the store", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.updateSession("s1", { time: { archived: 0 } })

    expect(store.listSessions("/work")).toEqual([{
      id: "s1",
      title: "Demo",
      directory: "/work",
      agent_session_id: "a1",
      time: {
        created: 1,
        updated: expect.any(Number),
        archived: 0,
      },
    }])

    expect(store.getSession("s1")).toMatchObject({
      id: "s1",
      title: "Demo",
      directory: "/work",
      agent_session_id: "a1",
      time: {
        created: 1,
        archived: 0,
      },
    })
  })

  it("persists session config across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.updateSessionConfig("s1", {
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "sonnet",
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })

    expect(first.getSessionConfig("s1")).toEqual({
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "sonnet",
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })

    const next = new RuntimeStore(root)
    expect(next.getSessionConfig("s1")).toEqual({
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "sonnet",
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })
  })
})
