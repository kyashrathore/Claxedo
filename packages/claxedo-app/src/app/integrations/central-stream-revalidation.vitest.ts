import { describe, expect, it, vi } from "vitest"
import { createRoot, flush } from "solid-js"
import { createStreamConnectivity } from "../connection/stream-connectivity"
import { useWorkGraphSyncLifecycle, type WorkGraphEventsApi } from "@/features/workgraph/sync-lifecycle"
import { createDocumentIndexController } from "@/features/documents/editor/document-index"
import type { DocumentsApi, DocumentSummary } from "@/features/documents/data/documents-api"

/**
 * Central-stream connectedness is the revalidation edge.
 *
 * These tests compose the REAL shell connectivity accounting
 * (`app/connection/stream-connectivity.ts`) with the REAL feature consumers, in
 * the shape the shell actually wires them: the shell's central + per-workspace
 * relay streams both report into one connectivity unit, and each feature reads
 * the CENTRAL bit through its own seam.
 *
 * The scenario under test is the one that broke: a user with a remote workspace
 * open (so >= 2 stream targets exist), central stream drops and comes back.
 * Against the old aggregate `connected()` the count goes 2 → 1 → 2, the signal
 * never goes false, no `false → true` edge fires, and the nudge missed during
 * the gap is lost forever — silent staleness.
 */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// Each tracker call stands for a stream callback, which lands in its own task in
// the shell. Solid 2 stages the signal write until the scheduler flushes, so a
// sequence sharing one task would leave every later read — and the consumers'
// own reads of `centralConnected()` — seeing the state from before it.
const report = (track: (value: boolean) => void, value: boolean) => {
  track(value)
  flush()
}

describe("central stream drop/recover while a workspace stream stays connected", () => {
  it("fires exactly one WorkGraph revalidation", async () => {
    vi.useFakeTimers()
    try {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("central")
      const workspace = connectivity.track("workspace")

      // Steady state: both streams up, board already loaded.
      report(central, true)
      report(workspace, true)

      const reload = vi.fn(() => Promise.resolve())
      const events: WorkGraphEventsApi = {
        on: () => () => {},
        centralConnected: connectivity.centralConnected,
      }

      const dispose = createRoot((disposeRoot) => {
        useWorkGraphSyncLifecycle({ active: () => true, reload, events })
        return disposeRoot
      })

      // The surface loads itself on mount; the lifecycle only reacts to LATER
      // transitions, so nothing has fired yet.
      vi.advanceTimersByTime(1_000)
      expect(reload).toHaveBeenCalledTimes(0)

      // The central stream drops. The workspace relay stream stays up, so the
      // shell's aggregate never even notices.
      report(central, false)
      expect(connectivity.connected()).toBe(true)
      vi.advanceTimersByTime(1_000)
      expect(reload).toHaveBeenCalledTimes(0)

      // …and recovers. This is the edge that must produce a revalidation.
      report(central, true)
      vi.advanceTimersByTime(1_000)
      expect(reload).toHaveBeenCalledTimes(1)

      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("fires exactly one Documents index revalidation", async () => {
    const connectivity = createStreamConnectivity()
    const central = connectivity.track("central")
    const workspace = connectivity.track("workspace")
    report(central, true)
    report(workspace, true)

    const list = vi.fn(() => Promise.resolve([] as DocumentSummary[]))
    let push: ((connected: boolean) => void) | undefined

    const controller = createDocumentIndexController({
      queries: [{ projectId: "prj_1" }],
      // The controller only calls `list` on this port (same double as
      // `document-index.test.ts`).
      api: { list } as DocumentsApi,
      subscribe: () => () => {},
      subscribeConnected: (handler) => {
        push = handler
        handler(connectivity.centralConnected())
        return () => {
          push = undefined
        }
      },
      onChange: () => {},
      onError: () => {},
    })
    controller.start()
    await controller.load()
    expect(list).toHaveBeenCalledTimes(1) // the initial load

    // Bridge the signal exactly as `document-index.tsx`'s effect does.
    const dispose = createRoot((disposeRoot) => {
      const connected = connectivity.centralConnected()
      push?.(connected)
      return disposeRoot
    })

    report(central, false)
    push?.(connectivity.centralConnected())
    await tick()
    expect(list).toHaveBeenCalledTimes(1)

    report(central, true)
    push?.(connectivity.centralConnected())
    await tick()
    expect(list).toHaveBeenCalledTimes(2)

    controller.stop()
    dispose()
  })
})
