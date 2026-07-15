import { describe, expect, test } from "vitest"
import { NotificationPageCursorError } from "@claxedo/workgraph/contracts"
import { createHostedNotificationService } from "./hosted-notifications"

describe("hosted WorkGraph notifications", () => {
  test.each(["invalid", "owner_mismatch", "filter_mismatch"] as const)(
    "normalizes a structured %s cursor rejection",
    async (reason) => {
      const service = createHostedNotificationService({
        serviceToken: "service-secret",
        executor: {
          mutation: async () => undefined,
          query: async () => {
            throw Object.assign(new Error("Convex query rejected"), {
              data: { code: "cursor_invalid", reason },
            })
          },
        },
      })

      await expect(service.list(context(), { after: "cursor" as never, limit: 1 }))
        .rejects.toMatchObject({
          name: "NotificationPageCursorError",
          code: "cursor_invalid",
          reason,
        })
      await expect(service.list(context(), { after: "cursor" as never, limit: 1 }))
        .rejects.toBeInstanceOf(NotificationPageCursorError)
    },
  )
})

function context() {
  return {
    organizationId: "organization",
    ownerUserId: "owner",
    actor: { type: "user", id: "owner" },
    requestId: "request",
    access: { mode: "owner" },
  } as never
}
