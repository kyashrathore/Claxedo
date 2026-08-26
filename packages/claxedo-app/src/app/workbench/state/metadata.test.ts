import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createStore, flush } from "solid-js"
import { emptyClaxedoState } from "./persistence"
import { createMetadataSlice } from "./metadata"

/**
 * Counts how often a tracked read is invalidated.
 *
 * Solid 2 has no `createComputed`; the equivalent is a two-phase
 * `createEffect` whose COMPUTE does the tracked read — the compute is the
 * phase that re-runs on invalidation, and returning the run count keeps it a
 * plain value. Writes stage until the scheduler flushes, so every caller
 * settles with `flush()` before reading the counter.
 */
function countInvalidations(read: () => unknown): () => number {
  let runs = 0
  createEffect(
    () => {
      read()
      runs += 1
      return runs
    },
    () => {},
  )
  return () => runs
}

/**
 * Constructs the slice — and any observers over it — inside an owned root, then
 * hands them back so the test drives the mutations from OUTSIDE that root.
 *
 * Solid 2 rejects a signal write made while an owned scope is current
 * (`REACTIVE_WRITE_IN_OWNED_SCOPE`), and the type and directory indexes here are
 * revision signals. Mutating from outside is also what the app does: metadata is
 * written by orchestration running from event handlers and actions, never from
 * inside a computation. The root still owns the observers, and the returned
 * `dispose` tears them down.
 */
function withMetadataRoot<T extends object>(build: () => T): T & { dispose: () => void } {
  return createRoot((dispose) => ({ ...build(), dispose }))
}

describe("state/metadata", () => {
  test("mutations land in the registry and notify observers in order", () => {
    const [state, setState] = createStore(emptyClaxedoState())
    const observed: Array<{ id: string; previous?: string; next?: string }> = []
    const meta = createMetadataSlice({
      state,
      setState,
      onChange: (change) =>
        observed.push({
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
    // Solid 2 stages store writes until the scheduler flushes; reads in the
    // same task see the committed snapshot, so settle before asserting.
    flush()
    expect(meta.all().map((item) => item.id)).toEqual(["session_1"])

    meta.patch("session_1", { directory: "/worktree" })
    flush()
    expect(meta.get("session_1")?.directory).toBe("/worktree")
    expect(meta.get("session_1")?.content).toMatchObject({ sessionId: "ses_1", title: "Session" })

    meta.remove("session_1")
    flush()
    expect(meta.all()).toEqual([])

    // `onChange` publishes one entry-scoped change per mutation, not a rebuilt
    // list — that is what lets the provider update a single open-session ref
    // instead of re-deriving every ref on every metadata write.
    expect(observed).toEqual([
      { id: "session_1", previous: undefined, next: "/work" },
      { id: "session_1", previous: "/work", next: "/worktree" },
      { id: "session_1", previous: "/worktree", next: undefined },
    ])
  })

  test("restored metadata is indexed at construction", () => {
    // Persistence rehydrates state.meta BEFORE the slice exists. The indexes are
    // built from that state in the constructor, so a restored session is visible
    // to every reader without waiting for the first unrelated meta mutation.
    // (The open-session refs seeded from it are the provider's job — see
    // `setOpenSessionMetas` in state/provider.tsx.)
    const [state, setState] = createStore(emptyClaxedoState())
    setState(($state) => {
      $state.meta["session_restored"] = {
        id: "session_restored",
        type: "session",
        scope: "directory",
        directory: "/work",
        sessionId: "ses_r",
        content: { type: "session", directory: "/work", sessionId: "ses_r", title: "Restored" },
      }
    })
    flush()

    const meta = createMetadataSlice({ state, setState })
    expect(meta.ids()).toEqual(["session_restored"])
    expect(meta.idsOfType("session")).toEqual(["session_restored"])
    expect(meta.directories()).toEqual(["/work"])
  })

  test("same-task patches chain on the draft, not the committed snapshot", () => {
    const [state, setState] = createStore(emptyClaxedoState())
    const meta = createMetadataSlice({ state, setState })
    const entry = {
      id: "session_1",
      type: "session" as const,
      scope: "directory" as const,
      directory: "/work",
      sessionId: "ses_A",
      content: { type: "session" as const, directory: "/work", sessionId: "ses_A", title: "Session" },
    }

    // A patch issued in the SAME task as the upsert that created the entry must
    // apply — the committed snapshot does not contain the entry yet.
    meta.upsert(entry)
    meta.patch("session_1", { directory: "/worktree" })
    flush()
    expect(meta.get("session_1")?.directory).toBe("/worktree")

    // A patch that reverts a field to its COMMITTED value after a same-task
    // change must not be skipped as "already equal": committed is ses_A, the
    // first patch stages undefined, the second restores ses_A.
    meta.patch("session_1", { sessionId: undefined })
    meta.patch("session_1", { sessionId: "ses_A" })
    flush()
    expect(meta.get("session_1")?.sessionId).toBe("ses_A")
  })

  test("ids accessor reflects dynamic metadata keys", () => {
    const { meta, dispose } = withMetadataRoot(() => {
      const [state, setState] = createStore(emptyClaxedoState())
      return { meta: createMetadataSlice({ state, setState }) }
    })

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
    flush()

    expect(meta.ids()).toEqual(["session_1"])

    meta.remove("session_1")
    flush()

    expect(meta.ids()).toEqual([])
    dispose()
  })

  test("keyed readers do not rerun when another metadata entry changes", () => {
    const { meta, firstEntryReads, idListReads, dispose } = withMetadataRoot(() => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      return {
        meta,
        firstEntryReads: countInvalidations(() => meta.get("session_1")),
        idListReads: countInvalidations(() => meta.ids()),
      }
    })
    flush()
    expect(firstEntryReads()).toBe(1)
    expect(idListReads()).toBe(1)

    meta.upsert({
      id: "session_2",
      type: "session",
      scope: "directory",
      directory: "/work",
      sessionId: "ses_2",
    })
    flush()
    expect(firstEntryReads()).toBe(1)
    expect(idListReads()).toBe(2)

    meta.patch("session_2", { directory: "/worktree" })
    flush()
    expect(firstEntryReads()).toBe(1)
    expect(idListReads()).toBe(2)

    dispose()
  })

  test("typed indexes react only to structural membership changes", () => {
    const { meta, terminalIndexReads, sessionIndexReads, dispose } = withMetadataRoot(() => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      return {
        meta,
        terminalIndexReads: countInvalidations(() => meta.idsOfType("terminal")),
        sessionIndexReads: countInvalidations(() => meta.idsOfType("session")),
      }
    })
    flush()
    expect(terminalIndexReads()).toBe(1)
    expect(sessionIndexReads()).toBe(1)

    meta.upsert({ id: "terminal_1", type: "terminal", terminalId: "pty_1", directory: "/work" })
    flush()
    expect(meta.idsOfType("terminal")).toEqual(["terminal_1"])
    expect(terminalIndexReads()).toBe(2)
    expect(sessionIndexReads()).toBe(1)

    meta.patch("terminal_1", { directory: "/worktree" })
    flush()
    expect(terminalIndexReads()).toBe(2)

    meta.upsert({ id: "terminal_1", type: "session", sessionId: "ses_1", directory: "/worktree" })
    flush()
    expect(meta.idsOfType("terminal")).toEqual([])
    expect(meta.idsOfType("session")).toEqual(["terminal_1"])
    expect(terminalIndexReads()).toBe(3)
    expect(sessionIndexReads()).toBe(2)
    dispose()
  })

  test("directory index does not publish title patches or duplicate directory membership", () => {
    const { meta, directoryReads, dispose } = withMetadataRoot(() => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })
      return { meta, directoryReads: countInvalidations(() => meta.directories()) }
    })
    flush()
    expect(directoryReads()).toBe(1)

    meta.upsert({
      id: "session_1",
      type: "session",
      sessionId: "ses_1",
      directory: "/work",
      content: { type: "session", sessionId: "ses_1", directory: "/work", title: "Initial" },
    })
    flush()
    expect(meta.directories()).toEqual(["/work"])
    expect(directoryReads()).toBe(2)

    meta.patch("session_1", {
      content: { type: "session", sessionId: "ses_1", directory: "/work", title: "Renamed" },
    })
    flush()
    expect(directoryReads()).toBe(2)

    meta.upsert({ id: "terminal_1", type: "terminal", terminalId: "pty_1", directory: "/work" })
    flush()
    expect(meta.directories()).toEqual(["/work"])
    expect(directoryReads()).toBe(2)

    meta.patch("terminal_1", { directory: "/worktree" })
    flush()
    expect(meta.directories()).toEqual(["/work", "/worktree"])
    expect(directoryReads()).toBe(3)

    meta.patch("session_1", { directory: "/worktree" })
    flush()
    expect(meta.directories()).toEqual(["/worktree"])
    expect(directoryReads()).toBe(4)

    meta.remove("terminal_1")
    flush()
    expect(meta.directories()).toEqual(["/worktree"])
    expect(directoryReads()).toBe(4)

    meta.remove("session_1")
    flush()
    expect(meta.directories()).toEqual([])
    expect(directoryReads()).toBe(5)
    dispose()
  })
})
