import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ConvexSignedAgentPluginActivationStore } from "./convex-store"

const auth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "signed-token",
  user: {
    subject: "user-1",
    issuer: "https://issuer.example",
    tokenIdentifier: "issuer|user-1",
    orgId: "org-1",
  },
}

describe("Convex Agent Plugins activation adapter", () => {
  test("uses the same durable operation ID for an exact network retry", async () => {
    const mutation = vi.fn(async (_fn: unknown, _args: Record<string, unknown>) => 1)
    const store = new ConvexSignedAgentPluginActivationStore({
      executor: { query: async () => undefined, mutation },
      serviceToken: "service-token",
    })
    const input = {
      pluginInstanceId: "claxedo/review",
      harnessIds: ["codex" as const],
      choice: true,
      target: { scope: "all-projects" as const },
      expectedRevision: 0,
      artifact: {
        digest: `sha256:${"a".repeat(64)}` as const,
        sourceId: "claxedo",
        relativePath: "review",
        sourceRevision: "commit-1",
      },
    }

    await store.mutateUser(auth, input)
    await store.mutateUser(auth, input)

    const first = mutation.mock.calls[0]![1] as Record<string, unknown>
    const retry = mutation.mock.calls[1]![1] as Record<string, unknown>
    expect(first.operation_id).toBe(retry.operation_id)
    expect(first.operation_id).toMatch(/^agent-plugins-[a-f0-9]{64}$/)
  })
})
