import { describe, expect, test } from "vitest"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { eventVisibleTo } from "./event-visibility"

const owner = { mode: "signed", subject: "user_owner", orgId: "org_a" } as const
const orgPeer = { mode: "signed", subject: "user_peer", orgId: "org_a" } as const

describe("control-plane event visibility", () => {
  test("the quota doorbell reaches every subscriber, signed in any org or none", () => {
    const event = { type: "usage.quota.changed", ts: 1 } as const
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_a", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b" }, event)).toBe(true)
  })

  test.each<ControlPlaneEvent>([
    { type: "provision", workspaceId: "ws_owner", orgId: "org_a", ownerUserId: "user_owner", step: "ready", ts: 1 },
    { type: "session.inventory.changed", workspaceId: "ws_owner", orgId: "org_a", ownerUserId: "user_owner", ts: 1 },
  ])("a $type notice reaches the workspace's owner and none of the owner's org peers", (event) => {
    expect(eventVisibleTo(owner, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_owner" }, event)).toBe(true)
    expect(eventVisibleTo(orgPeer, event)).toBe(false)
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
  })

  test.each<ControlPlaneEvent>([
    { type: "provision", workspaceId: "ws_unowned", orgId: "org_a", step: "ready", ts: 1 },
    { type: "session.inventory.changed", workspaceId: "ws_unowned", orgId: "org_a", ts: 1 },
  ])("a $type notice that names no owner reaches no signed subscriber, only the unsigned operator", (event) => {
    expect(eventVisibleTo(owner, event)).toBe(false)
    expect(eventVisibleTo(orgPeer, event)).toBe(false)
    expect(eventVisibleTo({ mode: "signed", subject: "" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
  })

  test("a Page notice reaches its org and no other", () => {
    const event: ControlPlaneEvent = { type: "document.changed", orgId: "org_a", projectId: "project_a", ts: 1 }
    expect(eventVisibleTo(orgPeer, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b", orgId: "org_b" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b" }, event)).toBe(false)
  })

  test("a live plugin notice reaches no signed subscriber, only the unsigned machine's single user", () => {
    const event = { type: "plugins.changed", pluginId: "notes", status: "ready", hash: "a".repeat(16), ts: 1 } as const
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_owner", orgId: "org_a" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "signed", subject: "user_member" }, event)).toBe(false)
  })
})
