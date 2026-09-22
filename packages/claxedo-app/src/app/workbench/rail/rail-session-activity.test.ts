import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createRailSessionActivity, type RailSessionActivity } from "./rail-session-activity"
import type { RailSessionStatusTarget } from "./rail-session-status-target"

function target(id: string): RailSessionStatusTarget {
  return { key: `central:${id}`, directory: "/w", sessionID: id }
}

/**
 * Drives the owner the way the rail does: a target set that changes as rows
 * come and go, and directory batch reads that answer some time later. `flushes`
 * counts how many times an outside reader of the projection was re-run, which
 * is what the reactive nesting is made of.
 */
function harness(
  seed: RailSessionStatusTarget[],
  focused?: () => RailSessionStatusTarget | undefined,
  turnFailed: (sessionID: string) => boolean = () => false,
) {
  return createRoot((dispose) => {
    const [targets, setTargets] = createSignal(seed)
    const [revision, bumpRevision] = createSignal(0)
    const activity: RailSessionActivity = createRailSessionActivity({
      targets,
      focusedTarget: focused ?? (() => undefined),
      activityRevision: revision,
      liveStatusType: () => undefined,
      turnFailed,
      optimisticStartedAt: () => undefined,
      autoResponds: () => false,
    })
    let flushes = 0
    createEffect(() => {
      activity.rowInputs()
      activity.unseenDone()
      flushes++
    })
    return {
      activity,
      targets,
      setTargets,
      bumpRevision,
      dispose,
      flushes: () => flushes,
      resetFlushes: () => (flushes = 0),
      statusOf: (id: string) => activity.rowInputs().get(`central:${id}`)?.statusType,
      keys: () => [...activity.rowInputs().keys()],
    }
  })
}

describe("createRailSessionActivity", () => {
  test("carries each row's failed-turn flag, re-read when session activity bumps", () => {
    const failed = new Set<string>()
    const rail = harness([target("a"), target("b")], undefined, (id) => failed.has(id))
    expect(rail.activity.rowInputs().get("central:a")?.failed).toBe(false)

    failed.add("a")
    rail.bumpRevision((value) => value + 1)
    expect(rail.activity.rowInputs().get("central:a")?.failed).toBe(true)
    expect(rail.activity.rowInputs().get("central:b")?.failed).toBe(false)
    rail.dispose()
  })

  test("projects a directory batch read onto the rows it answered for", () => {
    const rail = harness([target("a"), target("b")])
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 1_000,
      statuses: { a: { type: "busy" } },
    })
    expect(rail.statusOf("a")).toBe("busy")
    expect(rail.statusOf("b")).toBeUndefined()
    rail.dispose()
  })

  test("drops the entries of rows the rail no longer shows", () => {
    const rail = harness([target("a"), target("b")])
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 1_000,
      statuses: { a: { type: "busy" }, b: { type: "busy" } },
    })
    rail.setTargets([target("a")])
    expect(rail.keys()).toEqual(["central:a"])
    rail.setTargets([target("a"), target("b")])
    // `b` came back as an unanswered row, not as its own stale status.
    expect(rail.statusOf("b")).toBeUndefined()
    rail.dispose()
  })

  /**
   * The reason the projection's maps are written here and nowhere else.
   *
   * A batch is issued for the rows on screen when it starts and answers later,
   * so it can name a row that has gone since. Writing that answer and then
   * cleaning it up from an effect that READS the same maps put the effect's
   * writes in its own dependency set, and the write re-entered it — one more
   * reactive generation, and one more `runUpdates`/`completeUpdates` frame pair
   * of JS stack, for a row nobody can see.
   */
  test("a batch read that answers for a row the rail dropped changes nothing", () => {
    const rail = harness([target("a"), target("b")])
    const inFlight = [target("b")]
    rail.setTargets([target("a")])
    rail.resetFlushes()
    rail.activity.applyBatchRead({
      targets: inFlight,
      readStartedAt: 1_000,
      statuses: { b: { type: "busy" } },
    })
    expect(rail.keys()).toEqual(["central:a"])
    expect(rail.flushes()).toBe(0)
    rail.dispose()
  })

  test("marks a background row done once its turn ends, and clears it when focused", () => {
    const [focusedKey, setFocusedKey] = createSignal<string | undefined>(undefined)
    const rail = harness(
      [target("a")],
      () => (focusedKey() === "central:a" ? target("a") : undefined),
    )
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 1_000,
      statuses: { a: { type: "busy" } },
    })
    expect(rail.activity.unseenDone()["central:a"]).toBeUndefined()
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 2_000,
      statuses: { a: { type: "idle" } },
    })
    expect(rail.activity.unseenDone()["central:a"]).toBe(true)
    setFocusedKey("central:a")
    expect(rail.activity.unseenDone()["central:a"]).toBeUndefined()
    rail.dispose()
  })

  test("a blocking permission keeps a row active, so answering it marks the row done", () => {
    const rail = harness([target("a")])
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 1_000,
      permissions: [{ id: "p1", sessionID: "a" } as never],
    })
    expect(rail.activity.unseenDone()["central:a"]).toBeUndefined()
    rail.activity.applyBatchRead({
      targets: rail.targets(),
      readStartedAt: 2_000,
      permissions: [],
    })
    expect(rail.activity.unseenDone()["central:a"]).toBe(true)
    rail.dispose()
  })
})
