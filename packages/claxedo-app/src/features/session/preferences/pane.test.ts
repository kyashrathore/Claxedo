import { describe, expect, test } from "bun:test"
import {
  createPanePreferences,
  defaultReviewMode,
  initialPaneHarness,
  initialPaneValue,
  isDraftPaneScope,
  panePreferenceScope,
  PANE_PREFERENCE_KEYS,
  reviewModePreferenceScope,
  type PanePreferenceStorage,
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

describe("pane preferences", () => {
  test("builds session and draft scopes", () => {
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })).toBe("session:ses_1")
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "new", surfaceId: "tab_1" })).toBe(
      "draft:/tmp/proj:tab_1",
    )
    expect(panePreferenceScope({ directory: "/tmp/proj", draftId: "draft_1", surfaceId: "tab_1" })).toBe(
      "draft:draft_1",
    )
    expect(isDraftPaneScope("draft:/tmp/proj:tab_1")).toBe(true)
    expect(isDraftPaneScope("session:ses_1")).toBe(false)
  })

  test("reads and persists variant and review scope values", () => {
    const { data, storage } = memoryStorage()
    const prefs = createPanePreferences(storage)

    prefs.set("variant", "draft:one", "high")
    prefs.set("reviewMode", "draft:one", "to-from")

    expect(prefs.get("variant", "draft:one")).toBe("high")
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({ "draft:one": "high" })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)).toEqual({ "draft:one": "to-from" })

    prefs.set("variant", "draft:one", "")
    expect(prefs.get("variant", "draft:one")).toBeUndefined()
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({})
  })

  test("ignores malformed and non-string stored values", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.variant]: JSON.stringify({
        "draft:one": "sonnet",
        "draft:two": 42,
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(prefs.get("variant", "draft:one")).toBe("sonnet")
    expect(prefs.get("variant", "draft:two")).toBeUndefined()
  })

  test("promotes draft variant and review preferences into a session scope", () => {
    const { data, storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.variant]: JSON.stringify({ "draft:one": "fast" }),
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "draft:one": "unstaged" }),
    })
    const prefs = createPanePreferences(storage)

    prefs.promote("draft:one", "session:ses_1")

    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({
      "draft:one": "fast",
      "session:ses_1": "fast",
    })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)).toEqual({
      "draft:one": "unstaged",
      "session:ses_1": "unstaged",
    })
  })

  test("resolves review mode from stored preference with sensible fallback", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({
        [reviewModePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })]: "to-from",
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(defaultReviewMode("ses_1")).toBe("uncommitted")
    expect(defaultReviewMode()).toBe("uncommitted")
    expect(prefs.reviewMode({ directory: "/tmp/proj", sessionId: "ses_1" })).toBe("to-from")
    expect(prefs.reviewMode({ directory: "/tmp/proj", sessionId: "ses_2" })).toBe("uncommitted")
    expect(prefs.reviewMode({ directory: "/tmp/proj", fallback: "staged" })).toBe("staged")
  })

  test("ignores invalid stored review modes", () => {
    const { storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({
        [reviewModePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })]: "everything",
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(prefs.reviewMode({ directory: "/tmp/proj", sessionId: "ses_1" })).toBe("uncommitted")
    expect(prefs.reviewMode({ directory: "/tmp/proj", sessionId: "ses_1", fallback: "staged" })).toBe("staged")
  })

  test("ignores harness maps because harness migration is read-only elsewhere", () => {
    const { storage } = memoryStorage({
      "claxedo:runner-map": JSON.stringify({
        "session:ses_1": "claude-acp",
        "session:ses_2": "cursor-acp",
      }),
      "claxedo:harness-map": JSON.stringify({
        "session:ses_1": "codex-acp",
      }),
    })
    const prefs = createPanePreferences(storage)

    expect(prefs.get("variant", "session:ses_1")).toBeUndefined()
  })

  test("promote deletes stale destination values when the source has no value", () => {
    const { data, storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.variant]: JSON.stringify({ "session:ses_1": "stale" }),
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "session:ses_1": "staged" }),
    })
    const prefs = createPanePreferences(storage)

    prefs.promote("draft:missing", "session:ses_1")

    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({})
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)).toEqual({})
  })

  test("resolves initial pane values with draft-aware legacy fallbacks", () => {
    expect(initialPaneHarness("draft:/tmp/proj:route", undefined, "claude-acp")).toBeUndefined()
    expect(initialPaneHarness("session:ses_1", undefined, "claude-acp")).toBe("claude-acp")
    expect(initialPaneHarness("draft:/tmp/proj:route", "codex-acp", "claude-acp")).toBe("codex-acp")
    expect(initialPaneValue("draft:/tmp/proj:route", undefined, "opus")).toBe("")
    expect(initialPaneValue("session:ses_1", undefined, "opus")).toBe("opus")
    expect(initialPaneValue("draft:/tmp/proj:route", "sonnet", "opus")).toBe("sonnet")
  })
})
