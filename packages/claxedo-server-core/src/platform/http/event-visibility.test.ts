import { describe, expect, test } from "vitest"
import { eventVisibleTo } from "./event-visibility"

describe("control-plane event visibility", () => {
  test("the quota doorbell reaches every subscriber, signed in any org or none", () => {
    const event = { type: "usage.quota.changed", ts: 1 } as const
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_a", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b" }, event)).toBe(true)
  })

  test.each([
    { type: "document.changed", documentId: "doc_private", orgId: "org_a", projectId: "project_a", version: "v1", ts: 1 },
    { type: "provision", workspaceId: "ws_owner", orgId: "org_a", step: "ready", ts: 1 },
    { type: "session.inventory.changed", workspaceId: "ws_owner", orgId: "org_a", ts: 1 },
  ] as const)("a $type notice reaches no signed subscriber, its org's members included, only the unsigned machine's user", (event) => {
    expect(eventVisibleTo({ mode: "signed", subject: "user_a", orgId: "org_a" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
  })

  test("a session status notice reaches only the reader it names, in any org; never another member", () => {
    const event = {
      type: "session.status.changed",
      ownerUserId: "user_reader",
      orgId: "org_a",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      status: "busy",
      awaitingInput: false,
      ts: 1,
    } as const
    expect(eventVisibleTo({ mode: "signed", subject: "user_reader", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_reader" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_member", orgId: "org_a" }, event)).toBe(false)
  })

  test("a reader's own marks reach only that reader, never another reader of the session or a member of its org", () => {
    const event = { type: "session.reader.changed", ownerUserId: "user_reader", sessionId: "ses_shared", workspaceId: "ws_a", seenAt: 5, ts: 1 } as const
    expect(eventVisibleTo({ mode: "signed", subject: "user_reader", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_owner", orgId: "org_a" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "signed", subject: "user_other" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
  })

  test("a live plugin notice reaches no signed subscriber, only the unsigned machine's single user", () => {
    const event = { type: "plugins.changed", pluginId: "notes", status: "ready", hash: "a".repeat(16), ts: 1 } as const
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_owner", orgId: "org_a" }, event)).toBe(false)
    expect(eventVisibleTo({ mode: "signed", subject: "user_member" }, event)).toBe(false)
  })
})
