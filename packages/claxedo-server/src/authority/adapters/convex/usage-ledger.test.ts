import { describe, expect, test } from "vitest"
import { createConvexUsageLedger } from "./usage-ledger"

describe("Convex usage ledger", () => {
  test("maps the privacy-bounded revision and returns its per-item acknowledgement", async () => {
    const calls: Record<string, unknown>[] = []
    const ledger = createConvexUsageLedger({
      serviceToken: "service-secret",
      executor: {
        query: async () => null,
        mutation: async (_function, args) => {
          calls.push(args as Record<string, unknown>)
          return { results: [{ status: "stale", current_revision: 3, activated: false }] }
        },
      },
    })
    await expect(ledger.recordTurnUsageRevision?.({
      org_id: "org_1",
      user_id: "user_1",
      hostId: "host_1",
      sessionRef: "central:session_1",
      sessionId: "session_1",
      messageId: "message_1",
      revision: 2,
      observedAt: 10,
      completedAt: 20,
      settlement: "final",
      status: "completed",
      location: "central",
      harness: "pi",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      tokens: { input: 1, output: 2, reasoning: null, cache: { read: 3, write: null } },
      quality: { source: "provider", knownCategories: ["input", "output", "cache_read"] },
    })).resolves.toEqual({ status: "stale", currentRevision: 3, activated: false })
    expect(calls[0]).toMatchObject({
      org_id: "org_1",
      user_id: "user_1",
      service_token: "service-secret",
      revisions: [{
        host_id: "host_1",
        session_ref: "central:session_1",
        reasoning_tokens: null,
        cache_write_tokens: null,
      }],
    })
    expect(JSON.stringify(calls[0])).not.toContain("prompt")
  })

  test("reads tenant projections through the signed service seam", async () => {
    const calls: Record<string, unknown>[] = []
    const ledger = createConvexUsageLedger({
      serviceToken: "service-secret",
      executor: {
        mutation: async () => null,
        query: async (_function, args) => {
          calls.push(args as Record<string, unknown>)
          return { rows: [] }
        },
      },
    })
    await ledger.usageDashboard?.({ org_id: "org_1", user_id: "user_1", since: 1, until: 2 })
    await ledger.usageBreakdown?.({ org_id: "org_1", user_id: "user_1", since: 1, until: 2, dimension: "model" })
    expect(calls).toEqual([
      { org_id: "org_1", user_id: "user_1", since: 1, until: 2, service_token: "service-secret" },
      { org_id: "org_1", user_id: "user_1", since: 1, until: 2, dimension: "model", service_token: "service-secret" },
    ])
  })
})
