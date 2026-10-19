/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createSearchDebounce, COMBOBOX_SEARCH_DEBOUNCE_MS, type DebounceTimer } from "./search-debounce"

function fakeClock() {
  let now = 0
  let timers: { at: number; run: () => void; live: boolean }[] = []
  const timer: DebounceTimer = (run, delayMs) => {
    const entry = { at: now + delayMs, run, live: true }
    timers.push(entry)
    return () => {
      entry.live = false
    }
  }
  const advance = (ms: number) => {
    now += ms
    const due = timers.filter((entry) => entry.live && entry.at <= now)
    timers = timers.filter((entry) => !due.includes(entry))
    for (const entry of due) entry.run()
  }
  return { timer, advance, live: () => timers.filter((entry) => entry.live).length }
}

test("searches once, 250 ms after the last keystroke, with the latest query", () => {
  const clock = fakeClock()
  const searched: string[] = []
  const debounce = createSearchDebounce((query) => searched.push(query), clock.timer)
  debounce.schedule("c")
  clock.advance(100)
  debounce.schedule("cl")
  clock.advance(COMBOBOX_SEARCH_DEBOUNCE_MS - 1)
  expect(searched).toEqual([])
  clock.advance(1)
  expect(searched).toEqual(["cl"])
  expect(clock.live()).toBe(0)
})

test("a cancelled search never runs and leaves no timer behind", () => {
  const clock = fakeClock()
  const searched: string[] = []
  const debounce = createSearchDebounce((query) => searched.push(query), clock.timer)
  debounce.schedule("claxedo")
  debounce.cancel()
  clock.advance(1000)
  expect([searched, clock.live()]).toEqual([[], 0])
})
