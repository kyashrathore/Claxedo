import { describe, expect, test, vi } from "vitest"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import { createHostedOwnerDeletionExecution } from "./owner-deletion-execution"

const context = {
  ownerUserId: "owner_a",
  actor: { type: "user", id: "owner_a" },
  requestId: "request_a",
  access: { mode: "owner" },
} as WorkGraphContext

describe("hosted WorkGraph owner workspace cleanup", () => {
  test("destroys child isolations before the Stream envelope and releases every lease", async () => {
    const calls: string[] = []
    const execution = createHostedOwnerDeletionExecution({
      destroy: vi.fn(async (workspaceId: string) => {
        calls.push(`destroy:${workspaceId}`)
        return { ok: true as const, status: "destroyed" as const }
      }),
      release: vi.fn(async (workspaceId: string) => {
        calls.push(`release:${workspaceId}`)
        return { released: true }
      }),
    } as unknown as SandboxManager)

    await execution.cleanup(context, {
      streamId: "stream_a" as never,
      envelopeId: "envelope_a" as never,
      childIsolationIds: ["child_a" as never, "child_b" as never],
      reason: "delete",
    })

    expect(calls).toEqual([
      "destroy:child_a",
      "release:child_a",
      "destroy:child_b",
      "release:child_b",
      "destroy:envelope_a",
      "release:envelope_a",
    ])
  })

  test("accepts only an absent lease as an idempotent cleanup replay", async () => {
    const release = vi.fn(async () => ({ released: false }))
    const execution = createHostedOwnerDeletionExecution({
      destroy: vi.fn(async () => ({ ok: false as const, reason: "runtime_lease_missing" })),
      release,
    } as unknown as SandboxManager)

    await expect(execution.cleanup(context, {
      streamId: "stream_a" as never,
      envelopeId: "envelope_a" as never,
      reason: "delete",
    })).resolves.toBeUndefined()
    expect(release).not.toHaveBeenCalled()
  })

  test("fails when the hosted cleanup capability or a live workspace teardown fails", async () => {
    await expect(createHostedOwnerDeletionExecution(undefined).cleanup(context, {
      streamId: "stream_a" as never,
      envelopeId: "envelope_a" as never,
      reason: "delete",
    })).rejects.toThrow("requires a sandbox manager")

    const execution = createHostedOwnerDeletionExecution({
      destroy: vi.fn(async () => ({ ok: false as const, reason: "runtime_lease_not_ready" })),
    } as unknown as SandboxManager)
    await expect(execution.cleanup(context, {
      streamId: "stream_a" as never,
      envelopeId: "envelope_a" as never,
      reason: "delete",
    })).rejects.toThrow("runtime_lease_not_ready")
  })
})
