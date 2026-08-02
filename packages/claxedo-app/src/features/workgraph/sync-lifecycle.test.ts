import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createChangeCursor } from "@claxedo/workgraph/contracts"
import { useWorkGraphSyncLifecycle } from "./sync-lifecycle"
import type { WorkgraphChangedEvent } from "./workgraph-changed-event"

afterEach(() => {
  vi.useRealTimers()
})

describe("WorkGraph sync lifecycle", () => {
  test("skips only a doorbell older than the applied cursor by the overlap tolerance", async () => {
    vi.useFakeTimers()
    const snapshot = createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: 10_000 })
    const stale = createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: 5_000 })
    const [snapshotCursor] = createSignal(snapshot)
    const reload = vi.fn(async () => undefined)
    let handler: ((event: WorkgraphChangedEvent) => void) | undefined
    const dispose = createRoot((dispose) => {
      useWorkGraphSyncLifecycle({
        active: () => true,
        snapshotCursor,
        reload,
        events: {
          centralConnected: () => true,
          on: (_type, next) => {
            handler = next
            return () => {
              handler = undefined
            }
          },
        },
      })
      return dispose
    })
    await Promise.resolve()

    handler?.({ type: "workgraph.changed", ownerUserId: "owner", cursor: stale, ts: 1 })
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()

    expect(reload).not.toHaveBeenCalled()
    dispose()
  })

  test("reloads for a slightly-behind doorbell inside the overlap tolerance", async () => {
    vi.useFakeTimers()
    const snapshot = createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: 10_000 })
    const near = createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: 9_999 })
    const reload = vi.fn(async () => undefined)
    let handler: ((event: WorkgraphChangedEvent) => void) | undefined
    const dispose = createRoot((dispose) => {
      useWorkGraphSyncLifecycle({
        active: () => true,
        snapshotCursor: () => snapshot,
        reload,
        debounceMs: 1,
        events: {
          centralConnected: () => true,
          on: (_type, next) => {
            handler = next
            return () => {}
          },
        },
      })
      return dispose
    })
    await Promise.resolve()

    handler?.({ type: "workgraph.changed", ownerUserId: "owner", cursor: near, ts: 1 })
    vi.advanceTimersByTime(2)
    await Promise.resolve()

    expect(reload).toHaveBeenCalledTimes(1)
    dispose()
  })

  test("the visible idle-page poll recovers a missed doorbell within sixty seconds", async () => {
    vi.useFakeTimers()
    const reload = vi.fn(async () => undefined)
    const dispose = createRoot((dispose) => {
      useWorkGraphSyncLifecycle({
        active: () => true,
        reload,
        debounceMs: 1,
        events: {
          centralConnected: () => true,
          on: () => () => {},
        },
      })
      return dispose
    })
    await Promise.resolve()

    vi.advanceTimersByTime(60_001)
    await Promise.resolve()

    expect(reload).toHaveBeenCalledTimes(1)
    dispose()
  })
})
