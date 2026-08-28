import { describe, expect, test } from "bun:test"
import {
  reservedSessionEnvironmentOccupancy,
  createSessionEnvironmentCardState,
  resetSessionEnvironmentCardStateForTests,
  sessionEnvironmentCardCollapsePersist,
  sessionEnvironmentCardState,
  sessionEnvironmentCardCollapsed,
  withSessionEnvironmentCardCollapsed,
  migrateSessionEnvironmentCardPersist,
  MAX_SESSION_ENVIRONMENT_CARD_SNAPSHOTS,
} from "./session-environment-card-state"
import { setPersisted } from "@/platform/persistence/persist"

describe("migrateSessionEnvironmentCardPersist", () => {
  test("keeps per-session collapse and drops the v1 global boolean", () => {
    expect(
      migrateSessionEnvironmentCardPersist({
        collapsedBySessionId: { ses_a: false },
        recency: ["ses_a"],
        collapsed: false,
      }),
    ).toEqual({
      collapsedBySessionId: { ses_a: false },
      recency: ["ses_a"],
    })
    expect(migrateSessionEnvironmentCardPersist({ collapsed: false })).toEqual({
      collapsedBySessionId: {},
      recency: [],
    })
  })
})

describe("reservedSessionEnvironmentOccupancy", () => {
  test("reserves nothing on a draft session or while the workspace panel is open", () => {
    expect(reservedSessionEnvironmentOccupancy({ visible: false, ready: true, collapsed: true })).toBeUndefined()
  })

  test("reserves the collapsed rail until persist is ready", () => {
    expect(reservedSessionEnvironmentOccupancy({ visible: true, ready: false, collapsed: false })).toBe("collapsed")
  })

  test("reserves the user's expanded preference once persist is ready", () => {
    expect(reservedSessionEnvironmentOccupancy({ visible: true, ready: true, collapsed: false })).toBe("expanded")
    expect(reservedSessionEnvironmentOccupancy({ visible: true, ready: true, collapsed: true })).toBe("collapsed")
  })
})

describe("sessionEnvironmentCardCollapsed", () => {
  test("defaults collapsed for an unknown or draft session", () => {
    const persist = { collapsedBySessionId: { ses_a: false }, recency: ["ses_a"] }
    expect(sessionEnvironmentCardCollapsed(persist, undefined)).toBe(true)
    expect(sessionEnvironmentCardCollapsed(persist, "new")).toBe(true)
    expect(sessionEnvironmentCardCollapsed(persist, "ses_b")).toBe(true)
    expect(sessionEnvironmentCardCollapsed(persist, "ses_a")).toBe(false)
  })
})

describe("withSessionEnvironmentCardCollapsed", () => {
  test("keeps each session's collapse independent", () => {
    const first = withSessionEnvironmentCardCollapsed(
      { collapsedBySessionId: {}, recency: [] },
      "ses_a",
      false,
    )
    const second = withSessionEnvironmentCardCollapsed(first, "ses_b", true)
    expect(sessionEnvironmentCardCollapsed(second, "ses_a")).toBe(false)
    expect(sessionEnvironmentCardCollapsed(second, "ses_b")).toBe(true)
  })

  test("evicts the least-recent session once the retained set exceeds its bound", () => {
    let persist = { collapsedBySessionId: {}, recency: [] as string[] }
    for (let i = 0; i < MAX_SESSION_ENVIRONMENT_CARD_SNAPSHOTS + 1; i++) {
      persist = withSessionEnvironmentCardCollapsed(persist, `ses_${i}`, false)
    }
    expect(sessionEnvironmentCardCollapsed(persist, "ses_0")).toBe(true)
    expect(sessionEnvironmentCardCollapsed(persist, "ses_1")).toBe(false)
    expect(sessionEnvironmentCardCollapsed(persist, `ses_${MAX_SESSION_ENVIRONMENT_CARD_SNAPSHOTS}`)).toBe(false)
  })
})

describe("createSessionEnvironmentCardState", () => {
  test("defaults collapsed so a first visit does not open the card", () => {
    resetSessionEnvironmentCardStateForTests()
    localStorage.clear()
    const state = createSessionEnvironmentCardState()
    expect(state.collapsed("ses_new")).toBe(true)
  })

  test("toggling one session does not expand another", () => {
    resetSessionEnvironmentCardStateForTests()
    localStorage.clear()
    const state = createSessionEnvironmentCardState()
    state.setCollapsed("ses_a", false)
    expect(state.collapsed("ses_a")).toBe(false)
    expect(state.collapsed("ses_b")).toBe(true)
  })
})

describe("sessionEnvironmentCardState", () => {
  test("reads a persisted expanded preference for that session from the process-wide store", () => {
    resetSessionEnvironmentCardStateForTests()
    localStorage.clear()
    setPersisted(sessionEnvironmentCardCollapsePersist, {
      collapsedBySessionId: { ses_a: false },
      recency: ["ses_a"],
    })
    expect(sessionEnvironmentCardState().collapsed("ses_a")).toBe(false)
    expect(sessionEnvironmentCardState().collapsed("ses_b")).toBe(true)
    resetSessionEnvironmentCardStateForTests()
  })
})
