import { describe, expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { emptyClaxedoState } from "./persistence"
import { createMetadataSlice } from "./metadata"

describe("state/metadata", () => {
  test("notifies observers after metadata changes", () => {
    const [state, setState] = createStore(emptyClaxedoState())
    const observed: Array<{ id: string; previous?: string; next?: string }> = []
    const meta = createMetadataSlice({
      state,
      setState,
      onChange: (change) => observed.push({
        id: change.id,
        previous: change.previous?.directory,
        next: change.next?.directory,
      }),
    })

    meta.upsert({
      id: "session_1",
      type: "session",
      scope: "directory",
      directory: "/work",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "/work",
        sessionId: "ses_1",
        title: "Session",
      },
    })
    meta.patch("session_1", { directory: "/worktree" })
    meta.remove("session_1")

    expect(observed).toEqual([
      { id: "session_1", previous: undefined, next: "/work" },
      { id: "session_1", previous: "/work", next: "/worktree" },
      { id: "session_1", previous: "/worktree", next: undefined },
    ])
  })

  test("ids accessor reflects dynamic metadata keys", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })

      expect(meta.ids()).toEqual([])

      meta.upsert({
        id: "session_1",
        type: "session",
        scope: "directory",
        directory: "/work",
        sessionId: "new",
        content: {
          type: "session",
          directory: "/work",
          sessionId: "new",
          title: "New Session",
        },
      })

      expect(meta.ids()).toEqual(["session_1"])

      meta.remove("session_1")

      expect(meta.ids()).toEqual([])
      dispose()
    })
  })

  test("keyed readers do not rerun when another metadata entry changes", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      let firstEntryReads = 0
      let idListReads = 0

      createComputed(() => {
        meta.get("session_1")
        firstEntryReads += 1
      })
      createComputed(() => {
        meta.ids()
        idListReads += 1
      })

      meta.upsert({
        id: "session_2",
        type: "session",
        scope: "directory",
        directory: "/work",
        sessionId: "ses_2",
      })
      expect(firstEntryReads).toBe(1)
      expect(idListReads).toBe(2)

      meta.patch("session_2", { directory: "/worktree" })
      expect(firstEntryReads).toBe(1)
      expect(idListReads).toBe(2)

      dispose()
    })
  })

  test("typed indexes react only to structural membership changes", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      let terminalIndexReads = 0
      let sessionIndexReads = 0

      createComputed(() => {
        meta.idsOfType("terminal")
        terminalIndexReads += 1
      })
      createComputed(() => {
        meta.idsOfType("session")
        sessionIndexReads += 1
      })

      meta.upsert({ id: "terminal_1", type: "terminal", terminalId: "pty_1", directory: "/work" })
      expect(meta.idsOfType("terminal")).toEqual(["terminal_1"])
      expect(terminalIndexReads).toBe(2)
      expect(sessionIndexReads).toBe(1)

      meta.patch("terminal_1", { directory: "/worktree" })
      expect(terminalIndexReads).toBe(2)

      meta.upsert({ id: "terminal_1", type: "session", sessionId: "ses_1", directory: "/worktree" })
      expect(meta.idsOfType("terminal")).toEqual([])
      expect(meta.idsOfType("session")).toEqual(["terminal_1"])
      expect(terminalIndexReads).toBe(3)
      expect(sessionIndexReads).toBe(2)
      dispose()
    })
  })

  test("directory index does not publish title patches or duplicate directory membership", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      let directoryReads = 0

      createComputed(() => {
        meta.directories()
        directoryReads += 1
      })

      meta.upsert({
        id: "session_1",
        type: "session",
        sessionId: "ses_1",
        directory: "/work",
        content: { type: "session", sessionId: "ses_1", directory: "/work", title: "Initial" },
      })
      expect(meta.directories()).toEqual(["/work"])
      expect(directoryReads).toBe(2)

      meta.patch("session_1", {
        content: { type: "session", sessionId: "ses_1", directory: "/work", title: "Renamed" },
      })
      expect(directoryReads).toBe(2)

      meta.upsert({ id: "terminal_1", type: "terminal", terminalId: "pty_1", directory: "/work" })
      expect(meta.directories()).toEqual(["/work"])
      expect(directoryReads).toBe(2)

      meta.patch("terminal_1", { directory: "/worktree" })
      expect(meta.directories()).toEqual(["/work", "/worktree"])
      expect(directoryReads).toBe(3)

      meta.patch("session_1", { directory: "/worktree" })
      expect(meta.directories()).toEqual(["/worktree"])
      expect(directoryReads).toBe(4)

      meta.remove("terminal_1")
      expect(meta.directories()).toEqual(["/worktree"])
      expect(directoryReads).toBe(4)

      meta.remove("session_1")
      expect(meta.directories()).toEqual([])
      expect(directoryReads).toBe(5)
      dispose()
    })
  })
})
