import { describe, expect, test } from "bun:test"
import type { ConfigurationSlot, TaskSessionLinkView } from "@claxedo/tasks"
import { groupLinksBySlot, openableSlot, slotAttempt, taskKey } from "./view-model"

describe("the key a person quotes", () => {
  test("a multi-word project is its initials", () => {
    expect(taskKey("Demo project", 7)).toBe("DP-7")
    expect(taskKey("the claxedo control plane", 12)).toBe("TCCP-12")
  })

  test("a one-word project is its first three letters", () => {
    expect(taskKey("Claxedo", 1)).toBe("CLA-1")
    expect(taskKey("Go", 4)).toBe("GO-4")
  })

  test("a name longer than four words keeps the first four initials", () => {
    expect(taskKey("one two three four five six", 3)).toBe("OTTF-3")
  })

  test("a name with no words leaves the number to stand alone", () => {
    expect(taskKey("   ", 9)).toBe("#9")
  })
})

function link(
  slot: ConfigurationSlot,
  attempt: number,
  liveness: TaskSessionLinkView["liveness"],
  sessionId = `ses_${slot}_${attempt}`,
): TaskSessionLinkView {
  return {
    taskId: "tsk_1",
    slot,
    attempt,
    sessionRef: { sessionId, workspaceId: null },
    continuedFrom: null,
    presetId: "pre_1",
    presetRevision: 1,
    presetNameAtStart: "Careful reviewer",
    createdAt: 1,
    liveness,
    handoff: "sent",
  }
}

const groups = (...links: TaskSessionLinkView[]) => groupLinksBySlot(links)

describe("the slot an Open means", () => {
  test("a task that has never run has nothing to open", () => {
    expect(openableSlot(groups())).toBeUndefined()
  })

  // The row reads a link count and no slot, so a task started on Review alone
  // used to offer Open and then report having no session.
  test("a task whose only session is on a secondary slot opens that session", () => {
    const chosen = openableSlot(groups(link("review", 1, "live")))

    expect(chosen?.slot).toBe("review")
    expect(chosen?.open?.sessionRef.sessionId).toBe("ses_review_1")
  })

  test("primary wins over a secondary slot that also ran", () => {
    const chosen = openableSlot(groups(link("review", 1, "live"), link("primary", 1, "live")))

    expect(chosen?.slot).toBe("primary")
  })

  test("a live secondary session beats a slot whose session is gone", () => {
    const chosen = openableSlot(groups(link("planning", 1, "deleted"), link("review", 1, "live")))

    expect(chosen?.slot).toBe("review")
    expect(chosen?.open?.sessionRef.sessionId).toBe("ses_review_1")
  })

  test("with every session gone the refusal still has a slot and a link to name", () => {
    const chosen = openableSlot(groups(link("planning", 2, "deleted")))

    expect(chosen?.slot).toBe("planning")
    expect(chosen?.current.liveness).toBe("deleted")
    expect(chosen?.open).toBeUndefined()
  })

  test("the slot's current link is its highest attempt, and the next one follows it", () => {
    const chosen = openableSlot(groups(link("primary", 1, "deleted"), link("primary", 2, "live")))

    expect(chosen?.current.attempt).toBe(2)
    expect(slotAttempt(groups(link("primary", 1, "deleted"), link("primary", 2, "live")), "primary").attempt).toBe(2)
  })
})
