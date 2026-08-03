import { describe, expect, test } from "vitest"
import { createHostedAttentionAcknowledgementService } from "./attention"

describe("hosted WorkGraph Attention acknowledgements", () => {
  test("sends trusted tenant-scoped read and clear mutations to Convex", async () => {
    const calls: Record<string, unknown>[] = []
    const service = createHostedAttentionAcknowledgementService({
      serviceToken: "service-secret",
      now: () => 42,
      executor: {
        mutation: async (_fn, args) => {
          calls.push(args)
          const operation = args.operation as { type: string; now: number }
          return {
            ownerUserId: "internal_user_id",
            readAt: operation.now,
            ...(operation.type === "clear" ? { clearedAt: operation.now } : {}),
          }
        },
      },
    })

    await expect(service.markAllRead(context())).resolves.toEqual({ ownerUserId: "owner", readAt: 42 })
    await expect(service.clear(context())).resolves.toEqual({ ownerUserId: "owner", readAt: 42, clearedAt: 42 })
    expect(calls).toEqual([
      {
        service_token: "service-secret",
        organization_id: "organization",
        owner_subject: "owner",
        operation: { type: "mark_all_read", now: 42 },
      },
      {
        service_token: "service-secret",
        organization_id: "organization",
        owner_subject: "owner",
        operation: { type: "clear", now: 42 },
      },
    ])
  })
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
