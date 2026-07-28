import { describe, expect, test } from "vitest"
import { readWorkGraphProjection } from "../../../../convex/workgraphChanges"
import { resolveCanonicalRunExecutionDefaults } from "../../../../convex/workgraphCommands"

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

    expect(resolveCanonicalRunExecutionDefaults({ root: profile })).toEqual({
      environment: profile.environment,
      repository: profile.repository,
      harness: profile.harness,
      agent: profile.agent,
      model: profile.model,
      effort: profile.effort,
      tools: profile.tools,
      connectionIds: [],
    })
    expect(resolveCanonicalRunExecutionDefaults({ root: { execution: profile } })).toBeUndefined()
  })


})
