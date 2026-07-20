import { describe, it, expect } from "vitest"
import { getFunctionName } from "convex/server"
import { createWakeSettlementDispatcher } from "./wake-settlement-dispatcher"
import type { WakeLaneNamespace } from "./wake-lane"

const TENANT = { organizationId: "org_1", ownerUserId: "user_1" }

function harness(overrides?: { mutationError?: Error; fetchStatus?: number }) {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
  const nudges: Array<{ name: unknown; body: unknown }> = []
  const reported: unknown[] = []
  const settled: Array<Promise<unknown>> = []
  const namespace: WakeLaneNamespace = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (request: Request) => {
        nudges.push({ name: id, body: await request.json() })
        return new Response(null, { status: overrides?.fetchStatus ?? 204 })
      },
    }),
  }
  const dispatcher = createWakeSettlementDispatcher({
    namespace,
    waitUntil: (promise) => void settled.push(promise),
    serviceToken: "svc",
    now: () => 1_000,
    executor: {
      mutation: async (fn, args) => {
        if (overrides?.mutationError) throw overrides.mutationError
        mutations.push({ name: getFunctionName(fn as never), args })
        return { wakeId: "wake_x", created: true }
      },
    },
    reportError: ((e: unknown) => void reported.push(e)) as never,
  })
  const flush = async () => {
    await Promise.all(settled)
  }
  return { dispatcher, mutations, nudges, reported, flush }
}

describe("createWakeSettlementDispatcher", () => {
  it("creates the durable dirty-flag wake first, then nudges the lane DO", async () => {
    const { dispatcher, mutations, nudges, reported, flush } = harness()
    dispatcher.nudge(TENANT)
    await flush()

    expect(reported).toHaveLength(0)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.name).toContain("nudgeLaneWake")
    expect(mutations[0]!.args).toMatchObject({
      service_token: "svc",
      kind: "workgraph_settle",
      triggerType: "at",
      state: "pending",
      fireAt: 1_000,
      createdAt: 1_000,
    })
    expect(mutations[0]!.args.intentJson).toBe(JSON.stringify(TENANT))
    expect(String(mutations[0]!.args.id)).toMatch(/^wake_/)

    expect(nudges).toHaveLength(1)
    const body = nudges[0]!.body as { serialKey: string; fireAt: number }
    expect(body.fireAt).toBe(1_000)
    expect(body.serialKey).toBe(mutations[0]!.args.serialKey)
  })

  it("nudgeControl targets the dedicated control lane, not the settle lane", async () => {
    const { dispatcher, mutations, nudges, reported, flush } = harness()
    dispatcher.nudgeControl!(TENANT)
    await flush()

    expect(reported).toHaveLength(0)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.args).toMatchObject({ kind: "workgraph_control", fireAt: 1_000 })
    const serialKey = mutations[0]!.args.serialKey as string
    expect(serialKey.endsWith(":control")).toBe(true)
    // A distinct serialKey => a distinct ClaxedoWakeLane DO instance, so the
    // control drain never queues behind the settle lane.
    expect(serialKey).not.toBe(JSON.stringify(TENANT))
    expect(nudges).toHaveLength(1)
    expect((nudges[0]!.body as { serialKey: string }).serialKey).toBe(serialKey)
  })

  it("a failing wake creation reports and never reaches the DO or the caller", async () => {
    const { dispatcher, nudges, reported, flush } = harness({ mutationError: new Error("convex down") })
    expect(() => dispatcher.nudge(TENANT)).not.toThrow()
    await flush()
    expect(nudges).toHaveLength(0)
    expect(reported).toHaveLength(1)
  })

  it("a failing DO nudge reports without breaking the caller (the wake row is already durable)", async () => {
    const { dispatcher, mutations, reported, flush } = harness({ fetchStatus: 500 })
    dispatcher.nudge(TENANT)
    await flush()
    expect(mutations).toHaveLength(1) // wake row created
    expect(reported).toHaveLength(1) // DO failure reported, swallowed
  })
})
