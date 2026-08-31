import { describe, expect, test } from "bun:test"
import { applyPermissionMode, permissionModeDeliverable, type SessionPermissionWriter } from "./apply"
import type { PermissionModeDelivery } from "./modes"

describe("applyPermissionMode", () => {
  test("local answering sends nothing", async () => {
    const result = await applyPermissionMode({
      delivery: { kind: "claxedo-auto-answer", autoAnswer: ["read"], respondWith: "always" },
      sessionID: "ses_1",
      client: {},
    })
    expect(result).toEqual({ kind: "answered-locally" })
  })

  test("forwards a runtime-reported mode and preserves its activation boundary", async () => {
    const sent: unknown[] = []
    const client: SessionPermissionWriter = {
      setPermissionMode: async (input) => {
        sent.push(input)
        return { currentModeId: "kept" }
      },
    }
    const result = await applyPermissionMode({
      delivery: { kind: "harness-permission-mode", modeId: "full", appliesFrom: "next-session" },
      sessionID: "ses_1",
      client,
    })
    expect(sent).toEqual([{ sessionID: "ses_1", modeId: "full" }])
    expect(result).toEqual({ kind: "applied", appliesFrom: "next-session", kept: "kept" })
  })

  test("reports a missing runtime mode route", async () => {
    const result = await applyPermissionMode({
      delivery: { kind: "harness-permission-mode", modeId: "auto", appliesFrom: "next-turn" },
      sessionID: "ses_1",
      client: {},
    })
    expect(result).toEqual({ kind: "not-wired", delivery: "harness-permission-mode" })
  })
})

describe("permissionModeDeliverable", () => {
  const deliveries: PermissionModeDelivery[] = [
    { kind: "claxedo-auto-answer", autoAnswer: [], respondWith: "once" },
    { kind: "harness-permission-mode", modeId: "auto", appliesFrom: "next-turn" },
  ]

  test("covers every delivery kind", () => {
    expect(new Set(deliveries.map((delivery) => delivery.kind))).toEqual(
      new Set(["claxedo-auto-answer", "harness-permission-mode"]),
    )
    for (const delivery of deliveries) expect(permissionModeDeliverable(delivery.kind)).toBe(true)
  })
})
