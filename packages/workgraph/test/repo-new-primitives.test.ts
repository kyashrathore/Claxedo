import { describe, expect, test } from "vitest"
import { openSqlite } from "../src/model/db"
import type {
  ExternalReference,
  IntakeActivity,
  IntakeItem,
  LoadoutSlot,
  ReviewBatch,
  ReviewableDecision,
} from "../src/model/types"

const t0 = "2026-05-02T00:00:00.000Z"

function createRepo() {
  return openSqlite(":memory:")
}

function intakeItem(overrides: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: "intake_1",
    kind: "manual",
    title: null,
    bodyMd: "Rough note",
    status: "captured",
    repoRef: "github:acme/app",
    triageModeOverride: "normal",
    linkedSessionId: null,
    createdAt: t0,
    updatedAt: t0,
    lastTriagedAt: null,
    ...overrides,
  }
}

function activity(overrides: Partial<IntakeActivity> = {}): IntakeActivity {
  return {
    id: "activity_1",
    intakeItemId: "intake_1",
    kind: "capture",
    actor: "human",
    payload: { bodyMd: "Rough note" },
    createdAt: t0,
    ...overrides,
  }
}

function externalReference(overrides: Partial<ExternalReference> = {}): ExternalReference {
  return {
    id: "ref_1",
    intakeItemId: "intake_1",
    provider: "github",
    externalId: "42",
    externalUrl: "https://github.com/acme/app/issues/42",
    lastKnownState: { state: "open" },
    createdAt: t0,
    ...overrides,
  }
}

function decision(overrides: Partial<ReviewableDecision> = {}): ReviewableDecision {
  return {
    id: "decision_1",
    kind: "clarification",
    intentKind: "add_node",
    subjectType: "intake_item",
    subjectId: "intake_1",
    promptMd: "Add this task?",
    recommendedIntentPayload: { title: "Fix bug" },
    alternatives: [{ title: "Document bug" }],
    freeTextAnswer: null,
    confidence: 72,
    evidenceMd: "Scratchpad evidence",
    defaultAction: "ask",
    autoApplyAllowed: false,
    status: "open",
    batchId: null,
    createdBy: "captain",
    createdAt: t0,
    resolvedAt: null,
    ...overrides,
  }
}

function reviewBatch(overrides: Partial<ReviewBatch> = {}): ReviewBatch {
  return {
    id: "batch_1",
    submittedBy: "human",
    submittedAt: null,
    createdAt: t0,
    ...overrides,
  }
}

function loadoutSlot(overrides: Partial<LoadoutSlot> = {}): LoadoutSlot {
  return {
    id: "slot_1",
    scopeType: "repo",
    scopeId: "github:acme/app",
    kind: "triage_mode",
    payload: { name: "normal" },
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  }
}

describe("WorkGraphRepo new primitives", () => {
  test("round-trips IntakeItems", () => {
    const repo = createRepo()
    repo.insertIntakeItem(intakeItem())
    expect(repo.getIntakeItem("intake_1")).toEqual(intakeItem())

    repo.updateIntakeItem("intake_1", {
      title: "Triaged title",
      status: "triaged",
      linkedSessionId: "ses_1",
      lastTriagedAt: "2026-05-02T00:01:00.000Z",
    })
    expect(repo.getIntakeItem("intake_1")).toEqual({
      ...intakeItem(),
      title: "Triaged title",
      status: "triaged",
      linkedSessionId: "ses_1",
      lastTriagedAt: "2026-05-02T00:01:00.000Z",
      updatedAt: expect.any(String),
    })
    expect(repo.listIntakeItemsByStatus("triaged").map((item) => item.id)).toEqual(["intake_1"])
    repo.close()
  })

  test("appends IntakeActivity rows in chronological order", () => {
    const repo = createRepo()
    repo.insertIntakeItem(intakeItem())
    repo.appendIntakeActivity(activity({ id: "activity_2", kind: "human_edit", createdAt: "2026-05-02T00:02:00.000Z" }))
    repo.appendIntakeActivity(activity({ id: "activity_1", kind: "capture", createdAt: "2026-05-02T00:01:00.000Z" }))
    expect(repo.listIntakeActivities("intake_1").map((item) => item.id)).toEqual(["activity_1", "activity_2"])
    repo.close()
  })

  test("returns null for duplicate external references and records webhook dedup hits", () => {
    const repo = createRepo()
    repo.insertIntakeItem(intakeItem())
    expect(repo.insertExternalReference(externalReference())).toEqual(externalReference())
    expect(repo.insertExternalReference(externalReference({ id: "ref_2" }))).toBeNull()
    expect(repo.getExternalReferenceByProvider("github", "42")).toEqual(externalReference())
    expect(repo.insertExternalEventDedup({
      provider: "github",
      externalId: "42",
      externalEventId: "delivery-1",
      receivedAt: t0,
    })).toBe(true)
    expect(repo.insertExternalEventDedup({
      provider: "github",
      externalId: "42",
      externalEventId: "delivery-1",
      receivedAt: "2026-05-02T00:01:00.000Z",
    })).toBe(false)
    repo.close()
  })

  test("round-trips ReviewableDecisions and ReviewBatches", () => {
    const repo = createRepo()
    repo.insertReviewBatch(reviewBatch())
    repo.insertReviewableDecision(decision({ batchId: "batch_1" }))
    repo.updateReviewableDecision("decision_1", {
      status: "applied",
      freeTextAnswer: "Yes, but keep it small",
      resolvedAt: "2026-05-02T00:03:00.000Z",
    })
    repo.updateReviewBatch("batch_1", { submittedAt: "2026-05-02T00:03:00.000Z" })

    expect(repo.getReviewBatch("batch_1")).toEqual({
      ...reviewBatch(),
      submittedAt: "2026-05-02T00:03:00.000Z",
    })
    expect(repo.getReviewableDecision("decision_1")).toEqual({
      ...decision({ batchId: "batch_1" }),
      status: "applied",
      freeTextAnswer: "Yes, but keep it small",
      resolvedAt: "2026-05-02T00:03:00.000Z",
    })
    expect(repo.listReviewableDecisionsBySubject("intake_item", "intake_1").map((item) => item.id)).toEqual(["decision_1"])
    expect(repo.listOpenReviewableDecisions()).toEqual([])
    repo.close()
  })

  test("round-trips LoadoutSlots by scope and supports delete", () => {
    const repo = createRepo()
    repo.insertLoadoutSlot(loadoutSlot())
    repo.insertLoadoutSlot(loadoutSlot({ id: "slot_2", scopeType: "role", scopeId: "developer", payload: { name: "light" } }))
    repo.updateLoadoutSlot("slot_1", { payload: { name: "deep" }, updatedAt: "2026-05-02T00:04:00.000Z" })

    expect(repo.getLoadoutSlot("slot_1")).toEqual({
      ...loadoutSlot(),
      payload: { name: "deep" },
      updatedAt: "2026-05-02T00:04:00.000Z",
    })
    expect(repo.listLoadoutSlotsByScope("repo", "github:acme/app").map((item) => item.id)).toEqual(["slot_1"])
    repo.deleteLoadoutSlot("slot_1")
    expect(repo.getLoadoutSlot("slot_1")).toBeUndefined()
    repo.close()
  })
})
