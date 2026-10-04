import { describe, expect, test } from "vitest"
import {
  SANDBOX_LEASE_CLOSED,
  SANDBOX_LEASE_OPENED,
  emitSandboxLeaseClosed,
  emitSandboxLeaseOpened,
  leaseClosedProperties,
} from "./metering"
import type { ProductIdentity } from "./product"

const IDENTITY: ProductIdentity = {
  org_id: "org_1",
  user_id: "user_sub_1",
  surface: "session",
  deployment_mode: "cloud",
}

type Captured = { distinctId: string; event: string; properties: Record<string, unknown> }

function captureSink() {
  const events: Captured[] = []
  return {
    events,
    sink: {
      capture: (distinctId: string, event: string, properties: Record<string, unknown> = {}) => {
        events.push({ distinctId, event, properties })
      },
    },
    only: (event: string) => events.filter((item) => item.event === event),
  }
}

describe("sandbox lease events", () => {
  test("an opened lease carries the tenant, the driver, and the start", () => {
    const captured = captureSink()
    emitSandboxLeaseOpened({
      identity: IDENTITY,
      sink: captured.sink,
      lease: { workspace_id: "ws_1", driver: "modal", started_at: 1_000 },
    })
    expect(captured.only(SANDBOX_LEASE_OPENED)[0].properties).toMatchObject({
      workspace_id: "ws_1",
      driver: "modal",
      started_at: 1_000,
      org_id: "org_1",
    })
  })

  test("a close with a known start reports the subtraction; one without omits it", () => {
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "modal",
      started_at: 1_000,
      ended_at: 61_000,
      reason: "explicit_release",
    })).toMatchObject({ active_ms: 60_000, reason: "explicit_release" })

    // A zero here would average into the per-user answer as if the sandbox ran
    // for no time at all, so the field is absent instead.
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "modal",
      ended_at: 61_000,
      reason: "gc",
    })).not.toHaveProperty("active_ms")
  })

  test("the ledger's own subtraction wins over a locally reconstructed one", () => {
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "modal",
      started_at: 1_000,
      ended_at: 61_000,
      active_ms: 59_998,
      reason: "idle_timeout",
    }).active_ms).toBe(59_998)
  })

  test("an operator-token close lands on the ops plane and names the missing identity", () => {
    const captured = captureSink()
    emitSandboxLeaseClosed({
      identity: undefined,
      sink: captured.sink,
      lease: { workspace_id: "ws_1", driver: "modal", ended_at: 5, reason: "gc" },
      systemReason: "internal_admin_token_has_no_user",
    })
    const event = captured.only(SANDBOX_LEASE_CLOSED)[0]
    expect(event.distinctId).toBe("system")
    expect(event.properties.system_reason).toBe("internal_admin_token_has_no_user")
    expect(event.properties.org_id).toBeUndefined()
  })

  test("a throwing sink never propagates into the operation it observes", () => {
    const exploding = { capture: () => { throw new Error("sink down") } }
    expect(() => emitSandboxLeaseOpened({
      identity: IDENTITY,
      sink: exploding,
      lease: { workspace_id: "ws_1", driver: "modal", started_at: 1 },
    })).not.toThrow()
    expect(() => emitSandboxLeaseClosed({
      identity: undefined,
      sink: exploding,
      lease: { workspace_id: "ws_1", driver: "modal", ended_at: 1, reason: "gc" },
    })).not.toThrow()
  })
})
