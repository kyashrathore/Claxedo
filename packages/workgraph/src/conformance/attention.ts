import { AttentionCursorError, AttentionPageSchema } from "../contracts"
import type { AttentionKind, AttentionListInput, AttentionPage, WorkGraphContext } from "../contracts"

export const WORKGRAPH_ATTENTION_CONFORMANCE_VERSION = 1 as const

export type AttentionConformanceFactory = (input: Readonly<{
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<Readonly<{
  service: Readonly<{
    query: (
      context: WorkGraphContext,
      namespace: "attention",
      operation: "list",
      input: AttentionListInput,
    ) => Promise<AttentionPage>
  }>
  seed: (owner: WorkGraphContext) => Promise<Readonly<{ expectedKinds: readonly AttentionKind[] }>>
}>>

export function workGraphAttentionConformance(
  factory: AttentionConformanceFactory,
): readonly Readonly<{ name: string; run: () => Promise<void> }>[] {
  return [{
    name: "paginates deterministic owner-bound Attention without snapshot fallback",
    run: async () => {
      const owners = { first: owner("attention_owner_a"), second: owner("attention_owner_b") }
      const fixture = await factory({ owners })
      const firstSeed = await fixture.seed(owners.first)
      await fixture.seed(owners.second)
      const complete = AttentionPageSchema.parse(await fixture.service.query(owners.first, "attention", "list", { limit: 100 }))
      assert(complete.total === complete.items.length, "Attention total does not describe the complete owner projection")
      assertDeepEqual(complete.items.map((item) => item.kind), firstSeed.expectedKinds, "Attention order or kinds differ from the seeded projection")
      assert(complete.items.every((item) => item.ownerUserId === owners.first.ownerUserId), "Attention crossed its owner boundary")
      const first = AttentionPageSchema.parse(await fixture.service.query(owners.first, "attention", "list", { limit: 1 }))
      assert(first.hasMore && first.nextCursor, "Attention fixture did not produce a bounded first page")
      await assertCursorError(() => fixture.service.query(owners.second, "attention", "list", { limit: 1, after: first.nextCursor! }))
      const second = AttentionPageSchema.parse(await fixture.service.query(owners.first, "attention", "list", { limit: 100, after: first.nextCursor }))
      assertDeepEqual([...first.items, ...second.items].map((item) => `${item.kind}:${item.id}`), complete.items.map((item) => `${item.kind}:${item.id}`), "Attention resume skipped, duplicated, or reordered items")
      assert(second.total === complete.total, "Attention total changed across one unchanged cursor chain")
    },
  }]
}

async function assertCursorError(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    if (error instanceof AttentionCursorError || (error instanceof Error && error.name === "AttentionCursorError")) return
    throw error
  }
  throw new Error("Cross-owner Attention cursor was accepted")
}

function owner(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as WorkGraphContext["organizationId"],
    ownerUserId: ownerUserId as WorkGraphContext["ownerUserId"],
    actor: { type: "user", id: ownerUserId as WorkGraphContext["actor"]["id"] },
    requestId: `request_${ownerUserId}` as WorkGraphContext["requestId"],
    access: { mode: "owner" },
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
}
