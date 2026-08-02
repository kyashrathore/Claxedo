import { describe, it, expect } from "vitest"
import {
  createWakes,
  getWakeToolDefinitions,
  handleWakeToolCall,
  type Wakes,
  type WakeToolContext,
} from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

function setup(session = "s1", depth = 0) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const wakes: Wakes = createWakes({ store, now: () => clock.t, spawnTurn: async () => {} })
  const approvals: Array<{ token: string; prompt: string; wakeId: string }> = []
  const ctx: WakeToolContext = {
    wakes,
    sessionId: session,
    workspaceId: WS,
    actor: { userId: "marco" },
    depth,
    toolCallId: "call-1",
    now: () => clock.t,
    onApprovalRequested: (token, prompt, wakeId) => void approvals.push({ token, prompt, wakeId }),
  }
  return { clock, store, wakes, ctx, approvals }
}

describe("tool definitions", () => {
  it("exposes the four agent tools with required fields", () => {
    const names = getWakeToolDefinitions().map((d) => d.name)
    expect(names).toEqual(["schedule_followup", "watch", "request_approval", "cancel_wake"])
  })
})

describe("schedule_followup", () => {
  it("creates a wake scoped to the session, carrying depth+1 and the idempotency key", async () => {
    const { clock, wakes, ctx } = setup("s1", 2)
    const r = await handleWakeToolCall("schedule_followup", { when: "+3d", intent: { note: "chase" } }, ctx)
    expect(r.ok).toBe(true)
    const [w] = await wakes.listForSession("s1")
    expect(w!.sessionId).toBe("s1")
    expect(w!.workspaceId).toBe(WS)
    expect(w!.fireAt).toBe(clock.t + 3 * 86400_000)
    expect(w!.depth).toBe(3) // ctx.depth 2 + 1
    expect(w!.idempotencyKey).toBe("call-1")
    expect(w!.createdBy).toBe("marco")
  })

  it("rejects an unparseable time", async () => {
    const { ctx } = setup()
    await expect(handleWakeToolCall("schedule_followup", { when: "soon-ish" }, ctx)).rejects.toThrow()
  })
})

describe("request_approval", () => {
  it("hands the token to the host and does not leak it to the agent", async () => {
    const { ctx, approvals } = setup()
    const r = await handleWakeToolCall("request_approval", { prompt: "Approve migration?" }, ctx)
    expect(r.ok).toBe(true)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.prompt).toBe("Approve migration?")
    expect(r.text).not.toContain(approvals[0]!.token) // token stays server-side
  })
})

describe("cancel_wake", () => {
  it("cancels only wakes owned by this session", async () => {
    const a = setup("s1")
    const { wakeId } = await a.wakes.schedule({ sessionId: "s2", workspaceId: WS, at: a.clock.t + 1000, intent: {} })
    // s1's tool context cannot cancel s2's wake
    const r = await handleWakeToolCall("cancel_wake", { wake_id: wakeId }, a.ctx)
    expect(r.ok).toBe(false)
    expect((await a.store.get(wakeId))!.state).toBe("pending")

    // but it can cancel its own
    const own = await a.wakes.schedule({ sessionId: "s1", workspaceId: WS, at: a.clock.t + 1000, intent: {} })
    const r2 = await handleWakeToolCall("cancel_wake", { wake_id: own.wakeId }, a.ctx)
    expect(r2.ok).toBe(true)
    expect((await a.store.get(own.wakeId))!.state).toBe("cancelled")
  })
})

describe("watch", () => {
  it("parses expires_in and registers the event key", async () => {
    const { clock, wakes, ctx } = setup()
    await handleWakeToolCall("watch", { event_key: "ci:pass:x", expires_in: "12h" }, ctx)
    const [w] = await wakes.listForSession("s1")
    expect(w!.eventKey).toBe("ci:pass:x")
    expect(w!.expiresAt).toBe(clock.t + 12 * 3600_000)
  })
})
