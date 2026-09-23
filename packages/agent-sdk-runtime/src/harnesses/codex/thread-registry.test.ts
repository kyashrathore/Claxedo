import { describe, expect, test } from "bun:test"
import type { CodexActiveThread } from "./active-thread"
import { createCodexThreadRegistry, type CodexUnclaimedUsage } from "./thread-registry"

function registry() {
  const metered: CodexUnclaimedUsage[] = []
  const threads = createCodexThreadRegistry({ meter: (usage) => metered.push(usage) })
  const turn = (threadId: string, kind: "prompt" | "goal", sessionId: string) => {
    const claim = threads.beginTurn(threadId, kind)
    claim.attach({ sessionId, agentSessionId: threadId, directory: "/repo" } as CodexActiveThread, `assistant-${sessionId}`)
    return claim
  }
  const deliver = (method: string, params: Record<string, unknown>) => threads.observe({ method, params })
  const usage = (threadId: string, turnId: string, inputTokens: number) =>
    deliver("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        total: { inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: { inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: 1000,
      },
    })
  const meteredInput = () => metered.map((row) => ({
    sessionId: row.sessionId,
    assistantMessageId: row.assistantMessageId,
    scope: row.usage.observation?.scope,
    input: row.usage.observation?.tokens.input,
  }))
  return { threads, turn, deliver, usage, meteredInput }
}

describe("Codex thread registry", () => {
  test("a title thread no turn started is projected by no running turn, and billed to the session that asked for it", () => {
    const r = registry()
    const a = r.turn("thread-A", "prompt", "session-A")
    a.end()
    const b = r.turn("thread-B", "prompt", "session-B")
    r.deliver("thread/started", { thread: { id: "thread-title" } })
    const release = r.threads.attribute("thread-title", "thread-A", "gpt-5.4-mini")

    r.usage("thread-title", "title-1", 30)

    expect(r.threads.ownerOf("thread-title")).toBeUndefined()
    expect(r.threads.ownerOf("thread-B")).toBe(b)
    expect(r.meteredInput()).toEqual([{ sessionId: "session-A", assistantMessageId: "assistant-session-A", scope: "title:thread-title", input: 30 }])
    release()
    r.usage("thread-title", "title-1", 45)
    expect(r.meteredInput()).toHaveLength(1)
  })

  test("a Goal turn's subagent is that Goal turn's, never a concurrent prompt turn's, and its usage is the Goal turn's to meter", () => {
    const r = registry()
    const prompt = r.turn("thread-A", "prompt", "session-A")
    const goal = r.turn("thread-goal", "goal", "session-G")

    r.deliver("thread/started", { thread: { id: "goal-child", parentThreadId: "thread-goal" } })
    r.usage("goal-child", "c-1", 70)

    expect(r.threads.ownerOf("goal-child")).toBe(goal)
    expect(r.threads.ownerOf("goal-child")).not.toBe(prompt)
    expect(r.threads.firstLevel("goal-child")).toBe("goal-child")
    expect(goal.subagentThreads()).toEqual(["goal-child"])
    expect(r.meteredInput()).toEqual([])
  })

  test("a subagent that outlives its turn stays its session's: no other turn owns it, and its later spend is billed to the turn that started it", () => {
    const r = registry()
    const a = r.turn("thread-A", "prompt", "session-A")
    r.deliver("thread/started", { thread: { id: "child-A", parentThreadId: "thread-A" } })
    r.deliver("thread/started", { thread: { id: "grandchild-A", parentThreadId: "child-A" } })
    r.usage("child-A", "c-1", 100)
    a.end()
    const b = r.turn("thread-B", "prompt", "session-B")

    r.usage("child-A", "c-1", 100)
    r.usage("child-A", "c-1", 160)
    r.usage("grandchild-A", "g-1", 20)

    expect(r.threads.ownerOf("child-A")).toBeUndefined()
    expect(r.threads.ownerOf("child-A")).not.toBe(b)
    expect(r.threads.firstLevel("grandchild-A")).toBe("child-A")
    expect(r.meteredInput()).toEqual([
      { sessionId: "session-A", assistantMessageId: "assistant-session-A", scope: "detached:child-A", input: 60 },
      { sessionId: "session-A", assistantMessageId: "assistant-session-A", scope: "detached:grandchild-A", input: 20 },
    ])

    const again = r.turn("thread-A", "prompt", "session-A")
    expect(r.threads.ownerOf("child-A")).toBe(again)
  })

  test("a thread started beneath a child that runs its own turn is that turn's", () => {
    const r = registry()
    const a = r.turn("thread-A", "prompt", "session-A")
    r.deliver("thread/started", { thread: { id: "child-A", parentThreadId: "thread-A" } })
    a.end()
    const child = r.turn("child-A", "prompt", "session-child")

    r.deliver("thread/started", { thread: { id: "helper", parentThreadId: "child-A" } })

    expect(r.threads.ownerOf("helper")).toBe(child)
    expect(r.threads.firstLevel("helper")).toBe("helper")
  })

  test("a thread a turn started for a dynamic subagent is adopted as that turn's", () => {
    const r = registry()
    const a = r.turn("thread-A", "prompt", "session-A")

    r.threads.adopt("dynamic-child", "thread-A")

    expect(r.threads.ownerOf("dynamic-child")).toBe(a)
    expect(a.subagentThreads()).toEqual(["dynamic-child"])
  })
})
