import { describe, expect, test } from "vitest"
import { openSqlite } from "../src/model/db"
import { resolveLoadout } from "../src/model/loadout"
import "../src/model/auto-policies"
import "../src/model/triage-modes"
import type { IntakeItem, LoadoutSlot, WorkItem } from "../src/model/types"

const t0 = "2026-05-02T00:00:00.000Z"

function slot(overrides: Partial<LoadoutSlot> = {}): LoadoutSlot {
  return {
    id: crypto.randomUUID(),
    scopeType: "system",
    scopeId: null,
    kind: "triage_mode",
    payload: { name: "light", overrides: null },
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  }
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item_1",
    parentId: null,
    repoRef: "github:acme/app",
    repoLabel: "acme/app",
    title: "Task",
    description: "",
    nodeType: "task",
    status: "open",
    labels: [],
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
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
    triageModeOverride: null,
    linkedSessionId: null,
    createdAt: t0,
    updatedAt: t0,
    lastTriagedAt: null,
    ...overrides,
  }
}

describe("loadout resolver", () => {
  test("returns the registered system default when no slots are configured", () => {
    const repo = openSqlite(":memory:")

    expect(resolveLoadout({ type: "work_item", id: "missing" }, "auto_policy", repo)).toEqual(expect.objectContaining({
      source: "default",
      name: "default",
      scopeType: "system",
      scopeId: null,
    }))
    repo.close()
  })

  test("returns a WorkItem scoped slot over a repo scoped slot", () => {
    const repo = openSqlite(":memory:")
    repo.insertItem(item())
    repo.insertLoadoutSlot(slot({
      id: "repo_slot",
      scopeType: "repo",
      scopeId: "github:acme/app",
      payload: { name: "light", overrides: null },
    }))
    repo.insertLoadoutSlot(slot({
      id: "item_slot",
      scopeType: "work_item",
      scopeId: "item_1",
      payload: { name: "deep", overrides: { outputBudget: 12000 } },
    }))

    expect(resolveLoadout({ type: "work_item", id: "item_1" }, "triage_mode", repo)).toEqual(expect.objectContaining({
      source: "slot",
      slotId: "item_slot",
      name: "deep",
      scopeType: "work_item",
      payload: expect.objectContaining({ outputBudget: 12000 }),
    }))
    repo.close()
  })

  test("returns an IntakeItem scoped slot over a source-adapter scoped slot", () => {
    const repo = openSqlite(":memory:")
    repo.insertIntakeItem(intake())
    repo.insertLoadoutSlot(slot({
      id: "adapter_slot",
      scopeType: "source_adapter",
      scopeId: "github",
      payload: { name: "light", overrides: null },
    }))
    repo.insertLoadoutSlot(slot({
      id: "intake_slot",
      scopeType: "intake_item",
      scopeId: "intake_1",
      payload: { name: "deep", overrides: null },
    }))

    expect(resolveLoadout({ type: "intake_item", id: "intake_1", sourceAdapter: "github" }, "triage_mode", repo))
      .toEqual(expect.objectContaining({
        source: "slot",
        slotId: "intake_slot",
        name: "deep",
      }))
    repo.close()
  })

  test("same kind at multiple scopes resolves to the innermost slot", () => {
    const repo = openSqlite(":memory:")
    repo.insertItem(item())
    repo.insertLoadoutSlot(slot({ id: "system_slot", scopeType: "system", scopeId: null, payload: { name: "off", overrides: null } }))
    repo.insertLoadoutSlot(slot({ id: "repo_slot", scopeType: "repo", scopeId: "github:acme/app", payload: { name: "normal", overrides: null } }))

    expect(resolveLoadout({ type: "work_item", id: "item_1" }, "triage_mode", repo)?.slotId).toBe("repo_slot")
    repo.close()
  })

  test("auto triage mode routes a manual-note IntakeItem to normal", () => {
    const repo = openSqlite(":memory:")
    repo.insertIntakeItem(intake())

    expect(resolveLoadout({ type: "intake_item", id: "intake_1" }, "triage_mode", repo)).toEqual(expect.objectContaining({
      source: "default",
      name: "normal",
      payload: expect.objectContaining({ decisionAggressiveness: "medium" }),
    }))
    repo.close()
  })
})
