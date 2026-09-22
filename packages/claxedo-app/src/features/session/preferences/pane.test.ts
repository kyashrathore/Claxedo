import { describe, expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import {
  createPanePreferences,
  defaultReviewMode,
  isDraftPaneScope,
  panePreferenceScope,
  PANE_PREFERENCE_KEYS,
  reviewModePreferenceScope,
  type PanePreferenceStorage,
  type ReviewSelection,
} from "./pane"

function memoryStorage(seed?: Record<string, string>) {
  const data = new Map(Object.entries(seed ?? {}))
  return {
    data,
    storage: {
      getItem(key) {
        return data.get(key) ?? null
      },
      setItem(key, value) {
        data.set(key, value)
      },
    } satisfies PanePreferenceStorage,
  }
}

const stored = (data: Map<string, string>) => JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)

describe("pane preferences", () => {
  test("builds session and draft scopes", () => {
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })).toBe("session:ses_1")
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "new", surfaceId: "tab_1" })).toBe("draft:/tmp/proj:tab_1")
    expect(panePreferenceScope({ directory: "/tmp/proj", draftId: "draft_1", surfaceId: "tab_1" })).toBe("draft:draft_1")
    expect(isDraftPaneScope("draft:/tmp/proj:tab_1")).toBe(true)
    expect(isDraftPaneScope("session:ses_1")).toBe(false)
  })

  test("persists a review selection with its refs under the review-mode key", () => {
    const { data, storage } = memoryStorage()
    const prefs = createPanePreferences(storage)

    prefs.set("reviewMode", "draft:one", { mode: "to-from", fromRef: "main", toRef: "HEAD" })

    expect(prefs.get("reviewMode", "draft:one")).toEqual({ mode: "to-from", fromRef: "main", toRef: "HEAD" })
    expect(stored(data)).toEqual({ "draft:one": { mode: "to-from", fromRef: "main", toRef: "HEAD" } })

    prefs.set("reviewMode", "draft:one")
    expect(prefs.get("reviewMode", "draft:one")).toBeUndefined()
    expect(stored(data)).toEqual({})
  })

  test("reads a bare mode string stored before refs were persisted as a selection without refs", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "session:ses_1": "staged" }),
    })
    const prefs = createPanePreferences(storage)

    expect(prefs.get("reviewMode", "session:ses_1")).toEqual({ mode: "staged" })
    expect(prefs.reviewSelection({ directory: "/tmp/proj", sessionId: "ses_1" })).toEqual({ mode: "staged" })
  })

  test("drops malformed entries, unknown modes, and empty refs, and reads a branch mode with its base", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({
        "draft:one": "staged",
        "draft:two": 42,
        "draft:three": "everything",
        "draft:four": { mode: "to-from", fromRef: "", toRef: 7 },
        "draft:five": { mode: "sideways" },
        "draft:six": ["to-from"],
        "draft:eight": { mode: "branch-worktree", fromRef: "main", toRef: "HEAD" },
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(prefs.get("reviewMode", "draft:one")).toEqual({ mode: "staged" })
    expect(prefs.get("reviewMode", "draft:two")).toBeUndefined()
    expect(prefs.get("reviewMode", "draft:three")).toBeUndefined()
    expect(prefs.get("reviewMode", "draft:four")).toEqual({ mode: "to-from" })
    expect(prefs.get("reviewMode", "draft:five")).toBeUndefined()
    expect(prefs.get("reviewMode", "draft:six")).toBeUndefined()
    expect(prefs.get("reviewMode", "draft:eight")).toEqual({ mode: "branch-worktree", fromRef: "main", toRef: "HEAD" })
  })

  test("promotes draft review preferences into a session scope", () => {
    const { data, storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "draft:one": { mode: "unstaged" } }),
    })
    const prefs = createPanePreferences(storage)

    prefs.promote("draft:one", "session:ses_1")

    expect(stored(data)).toEqual({
      "draft:one": { mode: "unstaged" },
      "session:ses_1": { mode: "unstaged" },
    })
  })

  test("resolves the selection from the stored preference, then the fallback, then the default", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({
        [reviewModePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })]: { mode: "to-from", fromRef: "dev", toRef: "HEAD" },
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(defaultReviewMode("ses_1")).toBe("uncommitted")
    expect(defaultReviewMode()).toBe("uncommitted")
    expect(prefs.reviewSelection({ directory: "/tmp/proj", sessionId: "ses_1" })).toEqual({ mode: "to-from", fromRef: "dev", toRef: "HEAD" })
    expect(prefs.reviewSelection({ directory: "/tmp/proj", sessionId: "ses_2" })).toEqual({ mode: "uncommitted" })
    expect(prefs.reviewSelection({ directory: "/tmp/proj", fallback: { mode: "staged" } })).toEqual({ mode: "staged" })
  })

  test("promote deletes stale destination values when the source has no value", () => {
    const { data, storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "session:ses_1": "staged" }),
    })
    const prefs = createPanePreferences(storage)

    prefs.promote("draft:missing", "session:ses_1")

    expect(stored(data)).toEqual({})
  })

  test("one storage has one instance, and a tracked read re-runs on that instance's writes", () => {
    const { storage } = memoryStorage()
    const prefs = createPanePreferences(storage)
    expect(createPanePreferences(storage)).toBe(prefs)
    expect(createPanePreferences(memoryStorage().storage)).not.toBe(prefs)

    const seen: ReviewSelection[] = []
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        seen.push(createPanePreferences(storage).reviewSelection({ directory: "/tmp/proj", sessionId: "ses_1" }))
      })
      return dispose
    })
    prefs.set("reviewMode", "session:ses_1", { mode: "to-from", fromRef: "main", toRef: "HEAD" })
    prefs.set("reviewMode", "session:other", { mode: "staged" })
    dispose()

    expect(seen).toEqual([
      { mode: "uncommitted" },
      { mode: "to-from", fromRef: "main", toRef: "HEAD" },
      { mode: "to-from", fromRef: "main", toRef: "HEAD" },
    ])
  })
})
