import { describe, expect, test } from "bun:test"
import {
  provisionalSessionTitle,
  sessionTitleFromSources,
  sessionTitleSignature,
  stableSessionTitle,
} from "./session-title-sync"

describe("session title sync", () => {
  test("includes title changes in the reactive signature", () => {
    expect(sessionTitleSignature({ id: "ses_1", title: "AI generated title" })).not.toBe(
      sessionTitleSignature({ id: "ses_1", title: "First prompt title" }),
    )
    expect(sessionTitleSignature({ id: "ses_1", title: "Session", updatedAt: 2 })).not.toBe(
      sessionTitleSignature({ id: "ses_1", title: "Session", updatedAt: 1 }),
    )
    expect(sessionTitleSignature({ id: "ses_1", directory: "/repo/a", title: "Same" })).not.toBe(
      sessionTitleSignature({ id: "ses_1", directory: "/repo/b", title: "Same" }),
    )
  })

  test("prefers directory cache titles for mounted workspace sessions", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo",
      directorySessions: () => [{ id: "ses_1", title: "Generated from first message" }],
      inventory: {
        global: [{ id: "ses_1", title: "Older inventory title" }],
      },
    })).toBe("Generated from first message")
  })

  test("falls back to inventory titles for resumed mounted sessions", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_2",
      directory: "/repo",
      directorySessions: () => [],
      inventory: {
        byWorkspace: {
          "/repo": {
            sessions: [{ id: "ses_2", title: "Resume generated title" }],
          },
        },
      },
    })).toBe("Resume generated title")
  })

  test("returns undefined for empty placeholder titles", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_empty",
      inventory: {
        global: [{ id: "ses_empty", title: "   " }],
      },
    })).toBeUndefined()
  })

  test("resolves sidebar and tab sources with the same provisional-title precedence", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo/main",
      directorySessions: () => [{
        id: "ses_1",
        title: "New Session",
        time: { created: 10, updated: 10 },
      }],
      inventory: {
        global: [{ id: "ses_1", title: "Untitled session", createdAt: 10, updatedAt: 10 }],
      },
      provisionalTitle: "Fix the terminal pane",
    })).toBe("Fix the terminal pane")

    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo/main",
      directorySessions: () => [{
        id: "ses_1",
        title: "Repair terminal resizing",
        time: { created: 10, updated: 20 },
      }],
      provisionalTitle: "Fix the terminal pane",
    })).toBe("Repair terminal resizing")
  })

  test("scopes duplicate inventory IDs and selects concrete newest candidates", () => {
    const inventory = {
      global: [{ id: "ses_1", title: "Wrong scope", directory: "/repo/other", updatedAt: 99 }],
      byWorkspace: {
        ws_main: {
          sessions: [
            { id: "ses_1", title: "Untitled session", workspaceId: "ws_main", updatedAt: 50 },
            { id: "ses_1", title: "Older concrete", directory: "/repo/main", workspaceId: "ws_main", updatedAt: 10 },
            { id: "ses_1", title: "Newest concrete", directory: "/repo/main", workspaceId: "ws_main", updatedAt: 20 },
          ],
        },
      },
    }

    expect(sessionTitleFromSources({ sessionId: "ses_1", directory: "/repo/main", inventory })).toBe("Newest concrete")
    expect(sessionTitleFromSources({ sessionId: "ses_1", directory: "ws_main", inventory })).toBe("Newest concrete")
    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo/missing",
      inventory,
    })).toBeUndefined()
  })

  test("uses an unscoped inventory row but never another explicit scope", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo/main",
      inventory: {
        global: [
          { id: "ses_1", title: "Other workspace", directory: "/repo/other", updatedAt: 20 },
          { id: "ses_1", title: "Unscoped fallback", updatedAt: 10 },
        ],
      },
    })).toBe("Unscoped fallback")
  })

  test("derives a compact provisional title from the first prompt", () => {
    expect(provisionalSessionTitle("  Please   fix\n the terminal pane  ")).toBe("Please fix the terminal pane")
    expect(provisionalSessionTitle("hello! ")).toBe("hello!")
    expect(provisionalSessionTitle(" ")).toBeUndefined()
    expect(provisionalSessionTitle("x".repeat(80))).toBe(`${"x".repeat(72)}…`)
  })

  test("keeps a provisional title ahead of placeholder cache rows", () => {
    expect(stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      inventoryTitle: "New Session",
      provisionalTitle: "Fix the terminal pane",
    })).toEqual({
      sessionKey: "session:ses_1",
      title: "Fix the terminal pane",
      source: "provisional",
    })
  })

  test("preserves placeholder-shaped prompt text when its source is provisional", () => {
    ;(["Session", "New session"] as const).forEach((provisionalTitle) => {
      expect(stableSessionTitle(undefined, {
        sessionKey: "session:ses_1",
        inventoryTitle: "New Session",
        provisionalTitle,
      })).toMatchObject({ title: provisionalTitle, source: "provisional" })
    })
  })

  test("treats the canonical directory cache as authoritative for placeholder-shaped manual titles", () => {
    const concrete = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      directoryTitle: "Generated title",
      directoryUpdatedAt: 2,
    })

    expect(stableSessionTitle(concrete, {
      sessionKey: "session:ses_1",
      directoryTitle: "Session",
      directoryUpdatedAt: 3,
    })).toMatchObject({ title: "Session", source: "directory", updatedAt: 3 })
  })

  test("does not let a created lifecycle placeholder replace the provisional title", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })
    const lifecycle = stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      directoryTitle: "New Session",
      directoryUpdatedAt: 10,
      provisionalTitle: "Fix the terminal pane",
    })

    expect(lifecycle).toEqual(provisional)
    expect(stableSessionTitle(lifecycle, {
      sessionKey: "session:ses_1",
      directoryTitle: null,
      provisionalTitle: "Fix the terminal pane",
    })).toEqual(provisional)
    expect(stableSessionTitle(lifecycle, {
      sessionKey: "session:ses_1",
      directoryTitle: "Repair terminal resizing",
      directoryUpdatedAt: 20,
    })).toMatchObject({ title: "Repair terminal resizing", source: "directory", updatedAt: 20 })
  })

  test("keeps normalized null-title inventory fallbacks below a provisional title", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })

    expect(stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Untitled session",
      provisionalTitle: "Fix the terminal pane",
    })).toEqual(provisional)
  })

  test("keeps the current provisional title ahead of concrete inventory", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })
    expect(stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Terminal pane repair",
      inventoryUpdatedAt: 20,
      provisionalTitle: "Fix the terminal pane",
    })).toEqual(provisional)
  })

  test("uses concrete inventory only when no provisional title exists", () => {
    expect(stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Terminal pane repair",
      inventoryUpdatedAt: 20,
    })).toMatchObject({ title: "Terminal pane repair", source: "inventory", updatedAt: 20 })
  })

  test("replaces an inventory-first arrival when the provisional title lands", () => {
    const inventory = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Older inventory title",
      inventoryUpdatedAt: 10,
    })
    const provisional = stableSessionTitle(inventory, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Older inventory title",
      inventoryUpdatedAt: 10,
      provisionalTitle: "Fix the terminal pane",
    })

    expect(provisional).toMatchObject({ title: "Fix the terminal pane", source: "provisional" })
    expect(stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      directoryTitle: "Repair terminal resizing",
      directoryUpdatedAt: 20,
    })).toMatchObject({ title: "Repair terminal resizing", source: "directory" })
  })

  test("lets non-stale directory titles replace provisional and retained concrete titles", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })
    const directory = stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      directoryTitle: "Repair terminal resizing",
      directoryUpdatedAt: 20,
    })

    expect(directory).toMatchObject({ title: "Repair terminal resizing", source: "directory", updatedAt: 20 })
    expect(stableSessionTitle(directory, {
      sessionKey: "session:ses_1",
      directoryTitle: "Older title",
      directoryUpdatedAt: 19,
    })).toEqual(directory)
    expect(stableSessionTitle(directory, {
      sessionKey: "session:ses_1",
      directoryTitle: "Different equal-time title",
      directoryUpdatedAt: 20,
    })).toEqual(directory)
    expect(stableSessionTitle(directory, {
      sessionKey: "session:ses_1",
      directoryTitle: "Newer title",
      directoryUpdatedAt: 21,
    })).toMatchObject({ title: "Newer title", source: "directory", updatedAt: 21 })
  })

  test("does not promote an activity-refreshed placeholder over a provisional title", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })

    expect(stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      directoryTitle: "New Session",
      directoryUpdatedAt: 50,
      provisionalTitle: "Fix the terminal pane",
    })).toEqual(provisional)
  })

  test("accepts a newer placeholder-shaped manual transition from a directory title", () => {
    const generated = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      directoryTitle: "Generated title",
      directoryUpdatedAt: 20,
    })

    expect(stableSessionTitle(generated, {
      sessionKey: "session:ses_1",
      directoryTitle: "Session",
      directoryUpdatedAt: 21,
      provisionalTitle: "Fix the terminal pane",
    })).toMatchObject({ title: "Session", source: "directory", updatedAt: 21 })
  })

  test("retains the last concrete directory title through missing, null, empty, and stale inventory rows", () => {
    const concrete = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      directoryTitle: "Repair terminal resizing",
    })

    ;([undefined, null, ""] as const).forEach((directoryTitle) => {
      expect(stableSessionTitle(concrete, {
        sessionKey: "session:ses_1",
        directoryTitle,
        inventoryTitle: "Older inventory title",
        provisionalTitle: "Fix the terminal pane",
      })).toEqual(concrete)
    })
  })

  test("retains the provisional title when inventory changes until a concrete directory title arrives", () => {
    const provisional = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      provisionalTitle: "Fix the terminal pane",
    })
    const inventory = stableSessionTitle(provisional, {
      sessionKey: "session:ses_1",
      inventoryTitle: "Terminal pane repair",
    })
    expect(inventory).toEqual(provisional)

    ;([undefined, "New Session", "Older inventory title"] as const).forEach((inventoryTitle) => {
      expect(stableSessionTitle(inventory, {
        sessionKey: "session:ses_1",
        inventoryTitle,
        provisionalTitle: "Fix the terminal pane",
      })).toEqual(inventory)
    })

    expect(stableSessionTitle(inventory, {
      sessionKey: "session:ses_1",
      directoryTitle: "Repair terminal resizing",
      inventoryTitle: "Older inventory title",
    })).toMatchObject({ title: "Repair terminal resizing", source: "directory" })
  })

  test("does not retain title state across session switches", () => {
    const concrete = stableSessionTitle(undefined, {
      sessionKey: "session:ses_1",
      directoryTitle: "First session",
    })

    expect(stableSessionTitle(concrete, {
      sessionKey: "session:ses_2",
      directoryTitle: "New Session",
    })).toEqual({
      sessionKey: "session:ses_2",
      title: "New Session",
      source: "placeholder",
    })
  })
})
