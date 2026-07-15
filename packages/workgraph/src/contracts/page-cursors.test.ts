import { describe, expect, it } from "vitest"
import {
  NotificationPageCursorError,
  WorkSourcePageCursorError,
  createNotificationPageCursor,
  createWorkSourcePageCursor,
  readNotificationPageCursor,
  readWorkSourcePageCursor,
} from "./page-cursors"

describe("tenant-bound page cursors", () => {
  it("round-trips stable Work Source and Notification keyset positions", () => {
    const source = createWorkSourcePageCursor({ organizationId: "org_a", ownerUserId: "owner_a", createdAt: 10, sourceId: "source_a" })
    const notification = createNotificationPageCursor({ organizationId: "org_a", ownerUserId: "owner_a", state: "unread", createdAt: 20, notificationId: "notification_a" })

    expect(readWorkSourcePageCursor(source, "org_a", "owner_a")).toEqual({ createdAt: 10, sourceId: "source_a" })
    expect(readNotificationPageCursor(notification, "org_a", "owner_a", "unread")).toEqual({ createdAt: 20, notificationId: "notification_a" })
  })

  it("rejects cross-organization same-user, filter, and malformed reuse", () => {
    const source = createWorkSourcePageCursor({ organizationId: "org_a", ownerUserId: "same_user", createdAt: 10, sourceId: "source_a" })
    const notification = createNotificationPageCursor({ organizationId: "org_a", ownerUserId: "same_user", state: "unread", createdAt: 20, notificationId: "notification_a" })

    expect(() => readWorkSourcePageCursor(source, "org_b", "same_user"))
      .toThrow(expect.objectContaining<Partial<WorkSourcePageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readNotificationPageCursor(notification, "org_a", "same_user", "read"))
      .toThrow(expect.objectContaining<Partial<NotificationPageCursorError>>({ reason: "filter_mismatch" }))
    expect(() => readNotificationPageCursor("broken", "org_a", "same_user"))
      .toThrow(expect.objectContaining<Partial<NotificationPageCursorError>>({ reason: "invalid" }))
  })
})
