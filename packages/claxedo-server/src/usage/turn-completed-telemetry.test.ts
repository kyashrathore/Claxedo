import { afterEach, describe, expect, test } from "vitest"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./adapters/d1-usage-ledger"
import { modelFamily, tokensBucket, withTurnCompletedTelemetry } from "./turn-completed-telemetry"

const databases: ControlPlaneDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const DAY = Date.parse("2026-09-20T10:00:00Z")
const ALICE = { org_id: "org_acme", user_id: "user_alice" }

function revision(input: Partial<TurnUsageRevision>): TurnUsageRevision {
  return {
    sessionRef: "workspace:ws_main:session:ses_1",
    sessionId: "ses_1",
    workspaceId: "ws_main",
    hostId: "workspace:ws_main",
    location: "cloud-workspace",
    messageId: "msg_1",
    revision: 1,
    observedAt: DAY,
    completedAt: DAY + 4_000,
    settlement: "final",
    status: "completed",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    tokens: { input: 12_000, output: 800, reasoning: null, cache: { read: 2_000, write: 600 } },
    quality: { source: "provider", knownCategories: ["input", "output"] },
    ...input,
  }
}

async function filed() {
  const database = await miniflareControlPlaneDatabase()
  databases.push(database)
  const captured: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = []
  const writer = withTurnCompletedTelemetry(
    createD1UsageLedger({ database: database.database, now: () => DAY }),
    { capture: (distinctId, event, properties) => void captured.push({ distinctId, event, properties }) },
  )
  return { writer, captured }
}

describe("turn_completed from the filed usage row", () => {
  test("a settled row the ledger accepts is one event with the turn's shape and no content", async () => {
    const { writer, captured } = await filed()

    expect(await writer.writeRevision(revision({ revision: 1, settlement: "provisional", status: "running" }), { owner: ALICE, turnId: "turn_1", admittedAt: DAY - 1_000 }))
      .toEqual({ status: "accepted" })
    expect(await writer.writeRevision(revision({ revision: 2 }), { owner: ALICE, turnId: "turn_1", admittedAt: DAY - 1_000 }))
      .toEqual({ status: "accepted" })
    expect(await writer.writeRevision(revision({ revision: 2 }), { owner: ALICE, turnId: "turn_1", admittedAt: DAY - 1_000 }))
      .toEqual({ status: "duplicate" })

    expect(captured).toEqual([{
      distinctId: "user_alice",
      event: "turn_completed",
      properties: {
        harness: "claude",
        model_family: "claude-sonnet",
        outcome: "completed",
        settlement: "final",
        location: "cloud-workspace",
        tokens_bucket: "10k-100k",
        duration_ms: 5_000,
        workspace_id: "ws_main",
        org_id: "org_acme",
        $groups: { org: "org_acme" },
      },
    }])
  })

  test("a row filed under a later turn's lease carries no duration it cannot know", async () => {
    const { writer, captured } = await filed()

    await writer.writeRevision(revision({ status: "error" }), { owner: ALICE, turnId: "turn_1" })

    expect(captured[0]?.properties).toMatchObject({ outcome: "error" })
    expect(captured[0]?.properties).not.toHaveProperty("duration_ms")
  })

  test.each([
    ["claude-opus-5", "claude-opus"],
    ["openai/gpt-4.1", "gpt"],
    ["gemini-2.5-pro", "gemini"],
    ["o3", "other"],
  ])("model %s belongs to family %s", (model, family) => {
    expect(modelFamily(model)).toBe(family)
  })

  test("tokens are bucketed, and unknown when no category was reported", () => {
    expect(tokensBucket({ input: 400, output: 100, reasoning: null, cache: { read: null, write: null } })).toBe("<1k")
    expect(tokensBucket({ input: 900_000, output: 200_000, reasoning: 1, cache: { read: null, write: null } })).toBe(">=1m")
    expect(tokensBucket({ input: null, output: null, reasoning: null, cache: { read: 5, write: null } })).toBe("unknown")
  })
})
