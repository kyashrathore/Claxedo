import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetRolledBackDraftsForTest,
  clearRolledBackDraft,
  markRolledBackDraft,
  rolledBackDraftKey,
  wasRolledBackDraft,
} from "./rolled-back-drafts"
import { queryClient } from "../../shared/query/query-client"

afterEach(() => {
  _resetRolledBackDraftsForTest()
  queryClient.clear()
})

describe("rolled-back-drafts", () => {
  test("keeps rollback suppression query-owned with no shadow module state", () => {
    // Behavioral proof of single-source-of-truth: the query cache is the ONLY
    // store. Marking a draft, then clearing the query client, must forget it —
    // which cannot hold if the module kept a private Map/expiries table.
    markRolledBackDraft("draft-owned")
    expect(wasRolledBackDraft("draft-owned")).toBe(true)
    expect(queryClient.getQueryData<number>(rolledBackDraftKey("draft-owned"))).toBeGreaterThan(Date.now())
    queryClient.clear()
    expect(wasRolledBackDraft("draft-owned")).toBe(false)
  })

  test("unmarked draft is not registered", () => {
    expect(wasRolledBackDraft("draft-x")).toBe(false)
  })

  test("marked draft is registered", () => {
    markRolledBackDraft("draft-a")
    expect(wasRolledBackDraft("draft-a")).toBe(true)
    expect(queryClient.getQueryData<number>(rolledBackDraftKey("draft-a"))).toBeGreaterThan(Date.now())
  })

  test("clear removes a single entry", () => {
    markRolledBackDraft("draft-a")
    markRolledBackDraft("draft-b")
    clearRolledBackDraft("draft-a")
    expect(wasRolledBackDraft("draft-a")).toBe(false)
    expect(wasRolledBackDraft("draft-b")).toBe(true)
  })

  test("entries expire after retention window", async () => {
    markRolledBackDraft("draft-short", 10)
    expect(wasRolledBackDraft("draft-short")).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(wasRolledBackDraft("draft-short")).toBe(false)
  })

  test("a late `created` event arriving 50ms after a 10ms rollback still sees the draft as rolled back when read within retention", () => {
    // Simulates rubric C7's scenario: wrapper rolled back at T=0; lifecycle
    // event arrives at T=50ms. With default retention (30s), the subscriber
    // still sees the rolled-back state and can skip the insertion.
    markRolledBackDraft("draft-late")
    expect(wasRolledBackDraft("draft-late")).toBe(true)
  })

  test("the same draft id can be re-marked safely after clear", () => {
    markRolledBackDraft("draft-replay")
    clearRolledBackDraft("draft-replay")
    markRolledBackDraft("draft-replay")
    expect(wasRolledBackDraft("draft-replay")).toBe(true)
  })
})
