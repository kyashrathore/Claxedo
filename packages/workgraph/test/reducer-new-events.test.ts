import { describe, expect, test } from "vitest"
import { emptyState, replayEvents } from "../src/model/reducer"
import type {
  IntakeActivity,
  IntakeItem,
  LoadoutSlot,
  ReviewBatch,
  ReviewableDecision,
  WorkEvent,
} from "../src/model/types"

const t0 = "2026-05-02T00:00:00.000Z"

function event(seq: number, type: WorkEvent["type"], payload: unknown): WorkEvent {
  return {
    id: `evt_${seq}`,
    seq,
    type,
    payload: JSON.stringify(payload),
    actor: "system",
    createdAt: t0,
  }
}

function intake(overrides: Partial<IntakeItem> = {}): IntakeItem {
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

function batch(overrides: Partial<ReviewBatch> = {}): ReviewBatch {
  return {
    id: "batch_1",
    submittedBy: "human",
    submittedAt: "2026-05-02T00:02:00.000Z",
    createdAt: t0,
    ...overrides,
  }
}

function slot(overrides: Partial<LoadoutSlot> = {}): LoadoutSlot {
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

describe("reducer new WorkGraph events", () => {
  test("empty state includes async intake projections", () => {
    expect(emptyState()).toEqual({
      items: {},
      edges: [],
      scratchpads: [],
      intakeItems: {},
      intakeActivities: [],
      externalReferences: {},
      decisions: {},
      batches: {},
      loadoutSlots: {},
    })
  })

  test("projects intake, decision, batch, and loadout events", () => {
    const events = [
      event(1, "intake_item_created", intake()),
      event(2, "intake_item_updated", {
        id: "intake_1",
        changes: { title: "Triaged title", status: "triaged" },
      }),
      event(3, "intake_activity_appended", activity()),
      event(4, "external_reference_linked", {
        id: "ref_1",
        intakeItemId: "intake_1",
        provider: "github",
        externalId: "42",
        externalUrl: "https://github.com/acme/app/issues/42",
        lastKnownState: { state: "open" },
        createdAt: t0,
      }),
      event(5, "captain_proposed", { intentKind: "add_node", outcome: "clarification", firedRuleId: "default-low-confidence" }),
      event(6, "decision_created", decision()),
      event(7, "review_batch_submitted", batch()),
      event(8, "decision_resolved", {
        id: "decision_1",
        status: "applied",
        batchId: "batch_1",
        freeTextAnswer: "Looks right",
        resolvedAt: "2026-05-02T00:03:00.000Z",
      }),
      event(9, "loadout_slot_set", slot()),
    ]

    const state = replayEvents(events)
    expect(state.intakeItems.intake_1).toEqual({
      ...intake(),
      title: "Triaged title",
      status: "triaged",
    })
    expect(state.intakeActivities).toEqual([activity()])
    expect(state.externalReferences.ref_1).toEqual(expect.objectContaining({ provider: "github", externalId: "42" }))
    expect(state.decisions.decision_1).toEqual({
      ...decision(),
      status: "applied",
      batchId: "batch_1",
      freeTextAnswer: "Looks right",
      resolvedAt: "2026-05-02T00:03:00.000Z",
    })
    expect(state.batches.batch_1).toEqual(batch())
    expect(state.loadoutSlots.slot_1).toEqual(slot())
  })

  test("projects removal and terminal decision events", () => {
    const state = replayEvents([
      event(1, "external_reference_linked", {
        id: "ref_1",
        intakeItemId: "intake_1",
        provider: "github",
        externalId: "42",
        externalUrl: null,
        lastKnownState: null,
        createdAt: t0,
      }),
      event(2, "external_reference_unlinked", { id: "ref_1" }),
      event(3, "decision_created", decision({ id: "decision_snoozed" })),
      event(4, "decision_snoozed", { id: "decision_snoozed" }),
      event(5, "decision_created", decision({ id: "decision_expired" })),
      event(6, "decision_expired", { id: "decision_expired", resolvedAt: "2026-05-02T00:05:00.000Z" }),
      event(7, "loadout_slot_set", slot()),
      event(8, "loadout_slot_cleared", { id: "slot_1" }),
      event(9, "captain_failed", { scratchpadId: "scratchpad_1", errorClass: "ToolError" }),
    ])

    expect(state.externalReferences.ref_1).toBeUndefined()
    expect(state.decisions.decision_snoozed.status).toBe("snoozed")
    expect(state.decisions.decision_expired).toEqual(expect.objectContaining({
      status: "expired",
      resolvedAt: "2026-05-02T00:05:00.000Z",
    }))
    expect(state.loadoutSlots.slot_1).toBeUndefined()
  })

  test("replaying duplicated new events is idempotent for projections", () => {
    const events = [
      event(1, "intake_item_created", intake()),
      event(2, "intake_activity_appended", activity()),
      event(3, "decision_created", decision()),
      event(4, "loadout_slot_set", slot()),
    ]
    expect(replayEvents([...events, ...events])).toEqual(replayEvents(events))
  })
})
