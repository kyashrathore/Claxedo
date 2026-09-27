/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { OlderState, SessionView } from "@/session"
import { createHistoryPaging } from "./history-paging"
import { createTurnPick } from "./turn-pick"

const TURNS_PER_PAGE = 25

function fakeView(turns: number, options: { readonly failAt?: number } = {}) {
  const [loaded, setLoaded] = createSignal(1)
  const [olderState, setOlderState] = createSignal<OlderState>({ kind: "idle" })
  const all = Array.from({ length: turns }, (_, index) => ({ id: `turn-${String(index + 1).padStart(2, "0")}` }))
  let loads = 0
  let inFlight: Promise<void> | undefined
  const view = {
    messages: () => all.slice(turns - loaded()),
    hasOlder: () => loaded() < turns,
    olderState,
    loadOlder: () => {
      loads += 1
      inFlight ??= Promise.resolve().then(() => {
        inFlight = undefined
        if (options.failAt !== undefined && loaded() + 1 === options.failAt) {
          setOlderState({ kind: "failed", error: { class: "network", message: "offline", retryable: true } })
          return
        }
        setLoaded((count) => Math.min(turns, count + TURNS_PER_PAGE))
        setOlderState({ kind: "idle" })
      })
      setOlderState({ kind: "loading" })
      return inFlight
    },
  } as unknown as SessionView
  return { view, loaded, loads: () => loads }
}

type Fake = ReturnType<typeof fakeView>

function paging(fake: Fake, scroller?: HTMLElement) {
  const anchors: string[] = []
  const paging = createHistoryPaging({
    view: () => fake.view,
    scroller: () => scroller,
    userScrolled: () => true,
    anchor: () => ({ capture: () => anchors.push("capture"), restore: () => anchors.push("restore"), settle: () => anchors.push("settle") }),
  })
  return { paging, anchors }
}

async function landed() {
  await Promise.resolve()
  await Promise.resolve()
}

test("history paging: loadUntil pages older history, anchored each time, until the reader's turn is loaded", async () => {
  const fake = fakeView(100)
  const { paging: pager, anchors } = paging(fake)
  expect(await pager.loadUntil(() => fake.loaded() >= 76)).toBe(true)
  expect(fake.loaded()).toBe(76)
  expect(fake.loads()).toBe(3)
  expect(anchors).toEqual(["capture", "restore", "capture", "restore", "capture", "restore"])
})

test("history paging: loadUntil gives up when no older page exists or a page fails", async () => {
  const exhausted = fakeView(2)
  expect(await paging(exhausted).paging.loadUntil(() => false)).toBe(false)
  expect(exhausted.loaded()).toBe(2)
  const failing = fakeView(5, { failAt: 2 })
  expect(await paging(failing).paging.loadUntil(() => false)).toBe(false)
  expect(failing.loaded()).toBe(1)
})

test("history paging: loadUntil issues no page once its run is no longer current", async () => {
  const fake = fakeView(100)
  expect(await paging(fake).paging.loadUntil(() => false, () => fake.loads() < 2)).toBe(false)
  expect(fake.loads()).toBe(2)
})

test("history paging: a failed page stops its own loadUntil but not the next one, which asks again", async () => {
  const failing = fakeView(5, { failAt: 2 })
  const { paging: pager } = paging(failing)
  expect(await pager.loadUntil(() => false)).toBe(false)
  expect(await pager.loadUntil(() => false)).toBe(false)
  expect(failing.loads()).toBe(2)
})

test("history paging: a scroll near the top loads one page and joins a page in flight instead of asking twice", async () => {
  const fake = fakeView(5)
  let loads = 0
  const original = fake.view.loadOlder
  ;(fake.view as { loadOlder: SessionView["loadOlder"] }).loadOlder = () => {
    loads += 1
    return original()
  }
  const { paging: pager } = paging(fake, { scrollTop: 0 } as HTMLElement)
  pager.onPull()
  pager.onPull()
  await landed()
  expect(fake.loaded()).toBe(5)
  expect(loads).toBe(1)
})

test("history paging: a reader's scroll pages once it is within one screen of the top, and not before", async () => {
  const fake = fakeView(5)
  const scroller = { scrollTop: 900, clientHeight: 800 } as HTMLElement
  const { paging: pager } = paging(fake, scroller)
  pager.onScroll()
  await landed()
  expect(fake.loads()).toBe(0)
  scroller.scrollTop = 799
  pager.onScroll()
  await landed()
  expect(fake.loads()).toBe(1)
})

const handles = { anchor: { capture: () => {}, restore: () => {}, settle: () => {} }, scrollToMessage: () => false }

function pick(view: () => SessionView, pager: ReturnType<typeof paging>["paging"]) {
  return createRoot((dispose) => ({ pick: createTurnPick({ view, loadUntil: pager.loadUntil, handles, selected: () => "turn-01", scroller: () => undefined }), dispose }))
}

test("turn pick: a cancel mid-paging issues no further page", async () => {
  const fake = fakeView(100)
  const { pick: turns } = pick(() => fake.view, paging(fake).paging)
  const seeking = turns.seek("turn-01")
  turns.cancel()
  await seeking
  expect(fake.loads()).toBe(1)
})

test("turn pick: a view change or disposal mid-paging issues no further page", async () => {
  const fake = fakeView(100)
  const [view, setView] = createSignal(fake.view)
  const { pick: changed } = pick(view, paging(fake).paging)
  const seeking = changed.seek("turn-01")
  setView(fakeView(1).view)
  await seeking
  expect(fake.loads()).toBe(1)
  const disposed = fakeView(100)
  const { pick: gone, dispose } = pick(() => disposed.view, paging(disposed).paging)
  const leaving = gone.seek("turn-01")
  dispose()
  await leaving
  expect(disposed.loads()).toBe(1)
})

test("turn pick: a second pick stops the first one's paging", async () => {
  const fake = fakeView(100)
  const { pick: turns } = pick(() => fake.view, paging(fake).paging)
  const first = turns.seek("turn-01")
  const second = turns.seek("turn-100")
  await Promise.all([first, second])
  expect(fake.loads()).toBe(1)
})
