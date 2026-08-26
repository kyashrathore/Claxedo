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
  const ctx: WakeToolContext = {
    wakes,
    sessionId: session,
    workspaceId: WS,
    actor: { userId: "marco" },
    depth,
    toolCallId: "call-1",
    now: () => clock.t,
  }
  return { clock, store, wakes, ctx }
}

describe("tool definitions", () => {
  it("exposes only the time-trigger tools with required fields", () => {
    const names = getWakeToolDefinitions().map((d) => d.name)
    expect(names).toEqual(["schedule_followup", "cancel_wake"])
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
    expect(w!.idempotencyKey).toBe("s1:call-1") // session-scoped, not raw call id
    expect(w!.createdBy).toBe("marco")
  })

  it("rejects an unparseable time", async () => {
    const { ctx } = setup()
    await expect(handleWakeToolCall("schedule_followup", { when: "soon-ish" }, ctx)).rejects.toThrow()
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

describe("idempotency scoping", () => {
  it("the same toolCallId in two sessions books two wakes", async () => {
    const a = setup("s1")
    await handleWakeToolCall("schedule_followup", { when: "+1h" }, a.ctx)
    await handleWakeToolCall("schedule_followup", { when: "+7d" }, { ...a.ctx, sessionId: "s2" })
    expect(await a.wakes.listForSession("s1")).toHaveLength(1)
    expect(await a.wakes.listForSession("s2")).toHaveLength(1)
  })

  it("the same toolCallId re-delivered in one session books once", async () => {
    const a = setup("s1")
    await handleWakeToolCall("schedule_followup", { when: "+1h" }, a.ctx)
    await handleWakeToolCall("schedule_followup", { when: "+1h" }, a.ctx)
    expect(await a.wakes.listForSession("s1")).toHaveLength(1)
  })
})

describe("retired tool names", () => {
  it("dispatches to the unknown-tool branch", async () => {
    const { ctx } = setup()
    const watch = await handleWakeToolCall("watch", { event_key: "ci:pass:x" }, ctx)
    expect(watch.ok).toBe(false)
    const approval = await handleWakeToolCall("request_approval", { prompt: "Approve?" }, ctx)
    expect(approval.ok).toBe(false)
  })
})
