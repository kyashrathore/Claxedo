/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { OlderState, SessionView } from "@/session"
import type { IdleWait } from "@/lib/idle"
import { BACKFILL_VIEWPORTS, createHistoryBackfill } from "./history-backfill"

const VIEWPORT = 600
const TURN_HEIGHT = 500

function fakeIdle() {
  const slots: Array<(ready: boolean) => void> = []
  let cancelled = 0
  const idle = (): IdleWait => {
    let finish!: (ready: boolean) => void
    const done = new Promise<boolean>((resolve) => (finish = resolve))
    slots.push(finish)
    return {
      done,
      cancel: () => {
        cancelled += 1
        finish(false)
      },
    }
  }
  return { slots, idle, cancelled: () => cancelled }
}

function harness(turns: number, input: { readonly open?: boolean; readonly whole?: boolean } = {}) {
  const [open, setOpen] = createSignal(input.open ?? true)
  const [whole, setWhole] = createSignal(input.whole ?? true)
  const [older, setOlder] = createSignal<OlderState>({ kind: "idle" })
  const [remaining, setRemaining] = createSignal(turns)
  const scroller = { scrollTop: 0, clientHeight: VIEWPORT } as HTMLElement
  const log: string[] = []
  const { slots, idle, cancelled } = fakeIdle()
  const view = {
    conversation: () => ({ messages: [{ id: "msg", role: "user" }], folded: new Map(whole() ? [] : [["msg", { foldableCount: 2 }]]) }),
    hasOlder: () => remaining() > 0,
    olderState: older,
    loadOlderTurn: async () => {
      log.push("read")
      setOlder({ kind: "loading" })
      await Promise.resolve()
      setRemaining((count) => count - 1)
      scroller.scrollTop += TURN_HEIGHT
      setOlder({ kind: "idle" })
    },
  } as unknown as SessionView
  const anchor = { capture: () => log.push("capture"), restore: () => log.push("restore"), settle: () => {} }
  const backfill = createHistoryBackfill({ view: () => view, scroller: () => scroller, anchor: () => anchor, open, idle })
  const runIdle = async () => {
    const due = slots.splice(0)
    for (const finish of due) finish(true)
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    return due.length
  }
  return { backfill, log, slots, scroller, runIdle, setOpen, setWhole, setOlder, remaining, cancelled }
}

function mounted(turns: number, input?: Parameters<typeof harness>[1]) {
  return createRoot((dispose) => ({ ...harness(turns, input), dispose }))
}

test("after the first paint, the open session loads one whole older turn per idle slot, anchored, until two viewports sit above the reader", async () => {
  const h = mounted(10)
  let units = 0
  while (await h.runIdle()) units += 1
  expect(h.scroller.scrollTop).toBeGreaterThanOrEqual(BACKFILL_VIEWPORTS * VIEWPORT)
  expect(units).toBe(Math.ceil((BACKFILL_VIEWPORTS * VIEWPORT) / TURN_HEIGHT) + 1)
  expect(h.log.slice(0, 3)).toEqual(["capture", "read", "restore"])
  expect(h.log.filter((entry) => entry === "read")).toHaveLength(units - 1)
  h.dispose()
})

test("nothing loads before the pane is revealed or while the latest turn is still a fragment, and it starts once both hold", async () => {
  const h = mounted(3, { open: false, whole: false })
  expect(await h.runIdle()).toBe(0)
  h.setOpen(true)
  expect(await h.runIdle()).toBe(0)
  h.setWhole(true)
  expect(await h.runIdle()).toBe(1)
  expect(h.log).toContain("read")
  h.dispose()
})

test("a session whose history ends stops reading, and a failed read waits instead of retrying", async () => {
  const ends = mounted(1)
  while (await ends.runIdle());
  expect(ends.log.filter((entry) => entry === "read")).toHaveLength(1)
  expect(ends.slots).toHaveLength(0)
  ends.dispose()
  const fails = mounted(3)
  fails.setOlder({ kind: "failed", error: { class: "network", message: "offline" } } as unknown as OlderState)
  expect(fails.cancelled()).toBe(1)
  await fails.runIdle()
  expect(fails.log).toEqual([])
  expect(fails.slots).toHaveLength(0)
  fails.dispose()
})

test("a scroll within the quiet window defers the next unit to a later idle slot", async () => {
  const clock = spyOn(performance, "now")
  let now = 1_000
  clock.mockImplementation(() => now)
  const h = mounted(3)
  h.backfill.onScroll()
  await h.runIdle()
  expect(h.log).toEqual([])
  now += 200
  await h.runIdle()
  expect(h.log).toEqual(["capture", "read", "restore"])
  h.dispose()
  clock.mockRestore()
})

test("leaving the session cancels the waiting idle slot", async () => {
  const h = mounted(3)
  expect(h.slots).toHaveLength(1)
  h.dispose()
  expect(h.cancelled()).toBe(1)
  await h.runIdle()
  expect(h.log).toEqual([])
})
