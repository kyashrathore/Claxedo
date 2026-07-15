import { describe, expect, test } from "vitest"
import { readWorkGraphProjection } from "../../../../convex/workgraphChanges"
import { resolveCanonicalAttemptExecutionDefaults } from "../../../../convex/workgraphCommands"

describe("Convex WorkGraph legacy quarantine", () => {
  test("does not execute a legacy nested root profile as canonical defaults", () => {
    const profile = {
      environment: { kind: "hosted_workspace" },
      repository: { baseRevision: "main" },
      harness: "codex",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "high",
      tools: [],
      isolation: "stream",
      cleanup: "retain",
      integration: "manual",
    }

    expect(resolveCanonicalAttemptExecutionDefaults({ root: profile })).toEqual({
      environment: profile.environment,
      repository: profile.repository,
      harness: profile.harness,
      agent: profile.agent,
      model: profile.model,
      effort: profile.effort,
      tools: profile.tools,
      connectionIds: [],
    })
    expect(resolveCanonicalAttemptExecutionDefaults({ root: { execution: profile } })).toBeUndefined()
  })

  test("invalidates a legacy non-Session Recap without fabricating execution metadata", async () => {
    const recap = {
      id: "recap_legacy",
      stream_id: "stream_1",
      owner_user_id: "owner_1",
      row_version: 1,
      created_at: 1,
      updated_at: 1,
      provenance: { actor: { type: "system", id: "legacy_import" } },
      activity_range: { fromSequence: 1, toSequence: 1, quietSince: 1 },
      summary: "Legacy summary",
      actionable_references: [{ type: "stream", id: "stream_1" }],
      generation: { state: "succeeded", method: "deterministic_fallback" },
      source_revision_refs: [],
    }
    const context = {
      db: {
        query(table: string) {
          const chain = {
            withIndex: () => chain,
            filter: () => chain,
            unique: async () => table === "workgraph_recaps" ? recap : undefined,
          }
          return chain
        },
      },
    }

    const result = await readWorkGraphProjection(context, "org_1", "owner_1", "recap", { recapId: recap.id })
    const generation = (result as { generation: Record<string, unknown> }).generation

    expect(result).toMatchObject({
      id: recap.id,
      actionableReferences: [],
      generation: {
        state: "invalidated",
        source: "retired_non_session_generation",
      },
    })
    expect(generation).not.toHaveProperty("model")
    expect(generation).not.toHaveProperty("effort")
  })
})
