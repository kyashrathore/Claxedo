import { describe, expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import { createSessionTitleProjection } from "./session-title-projection"

function row(input: Partial<SessionInventoryRow> & Pick<SessionInventoryRow, "id" | "title" | "directory">): SessionInventoryRow {
  return {
    projectID: input.directory,
    tags: [],
    attachments: [],
    time: { created: 1, updated: 1 },
    ...input,
  }
}

describe("session title projection", () => {
  test("indexes workspace rows by directory and workspace id aliases", () => {
    const projection = createSessionTitleProjection()
    const session = row({
      id: "ses_1",
      title: "Workspace title",
      directory: "/repo/main",
      workspaceId: "ws_main",
    })
    projection.replaceInventory([session])

    expect(projection.title({ sessionId: "ses_1", directory: "/repo/main" })).toBe("Workspace title")
    expect(projection.title({ sessionId: "ses_1", workspaceId: "ws_main" })).toBe("Workspace title")
    expect(projection.inventory({ sessionId: "ses_1", workspaceId: "ws_main" })).toEqual(session)
  })

  test("isolates duplicate ids across workspaces and from central sessions", () => {
    const projection = createSessionTitleProjection()
    projection.replaceInventory([
      row({ id: "ses_same", title: "Repo A", directory: "/repo/a" }),
      row({ id: "ses_same", title: "Repo B", directory: "/repo/b" }),
      row({ id: "ses_same", title: "Central", directory: "global", projectID: "global", tags: ["global"] }),
    ])

    expect(projection.title({ sessionId: "ses_same", directory: "/repo/a" })).toBe("Repo A")
    expect(projection.title({ sessionId: "ses_same", directory: "/repo/b" })).toBe("Repo B")
    expect(projection.title({ sessionId: "ses_same" })).toBe("Central")
  })

  test("selects concrete and then newest inventory candidates", () => {
    const projection = createSessionTitleProjection()
    projection.replaceInventory([
      row({ id: "ses_1", title: "Untitled session", directory: "/repo", time: { created: 1, updated: 30 } }),
      row({ id: "ses_1", title: "Older concrete", directory: "/repo", time: { created: 1, updated: 10 } }),
      row({ id: "ses_1", title: "Newest concrete", directory: "/repo", time: { created: 1, updated: 20 } }),
    ])

    expect(projection.title({ sessionId: "ses_1", directory: "/repo" })).toBe("Newest concrete")
  })

  test("keeps provisional through placeholders and replaces it with a concrete canonical title", () => {
    const projection = createSessionTitleProjection()
    const target = { sessionId: "ses_1", directory: "/repo" }
    projection.replaceInventory([row({ id: "ses_1", title: "New Session", directory: "/repo" })])
    projection.publishProvisional({ ...target, title: "Fix terminal resizing" })
    projection.publishCanonical({ ...target, title: "New Session", updatedAt: 10 })
    expect(projection.title(target)).toBe("Fix terminal resizing")

    projection.publishCanonical({ ...target, title: "Repair terminal resizing", updatedAt: 20 })
    expect(projection.title(target)).toBe("Repair terminal resizing")
  })

  test("fresh concrete inventory replaces a stale create-time provisional title", () => {
    const projection = createSessionTitleProjection()
    const target = { sessionId: "ses_1", directory: "/repo" }
    projection.replaceInventory([row({ id: "ses_1", title: "New Session", directory: "/repo" })])
    projection.publishProvisional({ ...target, title: "New Session" })

    projection.replaceInventory([row({
      id: "ses_1",
      title: "Usage limit is not working",
      directory: "/repo",
      time: { created: 1, updated: 20 },
    })])

    expect(projection.title(target)).toBe("Usage limit is not working")
    expect(projection.entry(target)?.provisionalTitle).toBeUndefined()
  })

  test("rejects stale and equal-time conflicting canonical titles", () => {
    const projection = createSessionTitleProjection()
    const target = { sessionId: "ses_1", directory: "/repo" }
    projection.publishCanonical({ ...target, title: "Current", updatedAt: 20 })
    projection.publishCanonical({ ...target, title: "Older", updatedAt: 19 })
    projection.publishCanonical({ ...target, title: "Conflict", updatedAt: 20 })
    expect(projection.title(target)).toBe("Current")

    projection.publishCanonical({ ...target, title: "Session", updatedAt: 21 })
    expect(projection.title(target)).toBe("Session")
  })

  test("propagates canonical updates across inventory aliases", () => {
    const projection = createSessionTitleProjection()
    projection.replaceInventory([row({
      id: "ses_1",
      title: "Inventory",
      directory: "/repo",
      workspaceId: "ws_1",
    })])
    projection.publishCanonical({ sessionId: "ses_1", directory: "/repo", title: "Canonical", updatedAt: 2 })

    expect(projection.title({ sessionId: "ses_1", workspaceId: "ws_1" })).toBe("Canonical")
  })

  test("carries a pre-inventory canonical title onto a newly discovered alias", () => {
    const projection = createSessionTitleProjection()
    projection.publishCanonical({ sessionId: "ses_1", directory: "/repo", title: "Canonical", updatedAt: 2 })
    projection.replaceInventory([row({
      id: "ses_1",
      title: "Inventory",
      directory: "/repo",
      workspaceId: "ws_1",
    })])

    expect(projection.title({ sessionId: "ses_1", workspaceId: "ws_1" })).toBe("Canonical")
  })

  test("inventory removal retains stronger sources and scoped delete removes only its target", () => {
    const projection = createSessionTitleProjection()
    const a = { sessionId: "ses_same", directory: "/repo/a" }
    const b = { sessionId: "ses_same", directory: "/repo/b" }
    projection.replaceInventory([
      row({ id: "ses_same", title: "A inventory", directory: "/repo/a" }),
      row({ id: "ses_same", title: "B inventory", directory: "/repo/b" }),
    ])
    projection.publishProvisional({ ...a, title: "A provisional" })
    projection.replaceInventory([row({ id: "ses_same", title: "B inventory", directory: "/repo/b" })])
    expect(projection.title(a)).toBe("A provisional")

    projection.remove(a)
    expect(projection.title(a)).toBeUndefined()
    expect(projection.title(b)).toBe("B inventory")
  })

  test("does not rerun a keyed reader when another session changes", () => {
    createRoot((dispose) => {
      const projection = createSessionTitleProjection()
      let reads = 0
      createComputed(() => {
        projection.title({ sessionId: "ses_a", directory: "/repo" })
        reads += 1
      })

      projection.publishCanonical({ sessionId: "ses_b", directory: "/repo", title: "B", updatedAt: 1 })
      expect(reads).toBe(1)
      projection.publishCanonical({ sessionId: "ses_a", directory: "/repo", title: "A", updatedAt: 1 })
      expect(reads).toBe(2)
      dispose()
    })
  })

  test("a bound selection resolves target aliases once across repeated reactive reads", () => {
    createRoot((dispose) => {
      const projection = createSessionTitleProjection()
      let sessionIdReads = 0
      let directoryReads = 0
      const selection = projection.select({
        get sessionId() {
          sessionIdReads += 1
          return "ses_a"
        },
        get directory() {
          directoryReads += 1
          return "/repo"
        },
      })
      expect(sessionIdReads).toBe(1)
      expect(directoryReads).toBe(1)
      const identityReads = { sessionId: sessionIdReads, directory: directoryReads }
      let reactiveReads = 0
      createComputed(() => {
        selection.title()
        reactiveReads += 1
      })

      projection.publishCanonical({ sessionId: "ses_b", directory: "/repo", title: "B", updatedAt: 1 })
      selection.title()
      selection.title()
      expect(reactiveReads).toBe(1)
      expect({ sessionId: sessionIdReads, directory: directoryReads }).toEqual(identityReads)

      projection.publishCanonical({ sessionId: "ses_a", directory: "/repo", title: "A", updatedAt: 1 })
      expect(reactiveReads).toBe(2)
      expect(selection.title()).toBe("A")
      expect({ sessionId: sessionIdReads, directory: directoryReads }).toEqual(identityReads)
      dispose()
    })
  })

  test("a bound alias selection receives later inventory and canonical updates without rebinding", () => {
    const projection = createSessionTitleProjection()
    const selection = projection.select({ sessionId: "ses_1", workspaceId: "ws_1" })

    projection.replaceInventory([row({
      id: "ses_1",
      title: "Inventory",
      directory: "/repo",
      workspaceId: "ws_1",
    })])
    expect(selection.title()).toBe("Inventory")

    projection.publishCanonical({ sessionId: "ses_1", directory: "/repo", title: "Canonical", updatedAt: 2 })
    expect(selection.title()).toBe("Canonical")
  })

  test("does not invalidate a keyed reader when identical inventory is republished", () => {
    createRoot((dispose) => {
      const projection = createSessionTitleProjection()
      const session = row({ id: "ses_a", title: "A", directory: "/repo" })
      projection.replaceInventory([session])
      let reads = 0
      createComputed(() => {
        projection.title({ sessionId: "ses_a", directory: "/repo" })
        reads += 1
      })

      projection.replaceInventory([session])
      expect(reads).toBe(1)
      dispose()
    })
  })
})
