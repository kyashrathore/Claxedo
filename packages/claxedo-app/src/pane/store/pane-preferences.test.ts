import { describe, expect, test } from "bun:test"
import {
  createPanePreferences,
  defaultReviewMode,
  initialPaneRunner,
  initialPaneValue,
  isDraftPaneScope,
  panePreferenceScope,
  PANE_PREFERENCE_KEYS,
  reviewModePreferenceScope,
  type PanePreferenceStorage,
} from "./pane-preferences"

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
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "ses_1" })).toBe("session:/tmp/proj:ses_1")
    expect(panePreferenceScope({ directory: "/tmp/proj", sessionId: "new", surfaceId: "tab_1" })).toBe("draft:/tmp/proj:tab_1")
    expect(panePreferenceScope({ directory: "/tmp/proj", draftId: "draft_1", surfaceId: "tab_1" })).toBe("draft:draft_1")
    expect(isDraftPaneScope("draft:/tmp/proj:tab_1")).toBe(true)
    expect(isDraftPaneScope("session:/tmp/proj:ses_1")).toBe(false)
  })

  test("reads and persists scope values", () => {
    const { data, storage } = memoryStorage()
    const prefs = createPanePreferences(storage)

    prefs.set("runner", "draft:one", "codex-acp")
    prefs.set("model", "draft:one", "gpt-5.4")
    prefs.set("variant", "draft:one", "high")
    prefs.set("reviewMode", "draft:one", "to-from")

    expect(prefs.get("runner", "draft:one")).toBe("codex-acp")
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.runner)!)).toEqual({ "draft:one": "codex-acp" })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.model)!)).toEqual({ "draft:one": "gpt-5.4" })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({ "draft:one": "high" })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)).toEqual({ "draft:one": "to-from" })

    prefs.set("model", "draft:one", "")
    expect(prefs.get("model", "draft:one")).toBeUndefined()
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.model)!)).toEqual({})
  })

  test("promotes draft preferences into a session scope", () => {
    const { data, storage } = memoryStorage({
      [PANE_PREFERENCE_KEYS.runner]: JSON.stringify({ "draft:one": "claude-acp" }),
      [PANE_PREFERENCE_KEYS.model]: JSON.stringify({ "draft:one": "sonnet" }),
      [PANE_PREFERENCE_KEYS.agent]: JSON.stringify({ "draft:one": "researcher" }),
      [PANE_PREFERENCE_KEYS.variant]: JSON.stringify({ "draft:one": "fast" }),
      [PANE_PREFERENCE_KEYS.reviewMode]: JSON.stringify({ "draft:one": "unstaged" }),
    })
    const prefs = createPanePreferences(storage)

    prefs.promote("draft:one", "session:/tmp/proj:ses_1")

    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.runner)!)).toEqual({
      "draft:one": "claude-acp",
      "session:/tmp/proj:ses_1": "claude-acp",
    })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.model)!)).toEqual({
      "draft:one": "sonnet",
      "session:/tmp/proj:ses_1": "sonnet",
    })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.agent)!)).toEqual({
      "draft:one": "researcher",
      "session:/tmp/proj:ses_1": "researcher",
    })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.variant)!)).toEqual({
      "draft:one": "fast",
      "session:/tmp/proj:ses_1": "fast",
    })
    expect(JSON.parse(data.get(PANE_PREFERENCE_KEYS.reviewMode)!)).toEqual({
      "draft:one": "unstaged",
      "session:/tmp/proj:ses_1": "unstaged",
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

  test("resolves initial pane values with draft-aware legacy fallbacks", () => {
    expect(initialPaneRunner("draft:/tmp/proj:route", undefined, "claude-acp")).toBeUndefined()
    expect(initialPaneRunner("session:/tmp/proj:ses_1", undefined, "claude-acp")).toBe("claude-acp")
    expect(initialPaneRunner("draft:/tmp/proj:route", "codex-acp", "claude-acp")).toBe("codex-acp")
    expect(initialPaneValue("draft:/tmp/proj:route", undefined, "opus")).toBe("")
    expect(initialPaneValue("session:/tmp/proj:ses_1", undefined, "opus")).toBe("opus")
    expect(initialPaneValue("draft:/tmp/proj:route", "sonnet", "opus")).toBe("sonnet")
  })
})
