import { createSignal, type Accessor } from "solid-js"
import { nextAgeChange } from "./relative-time"

type Reader = { readonly at: number; next: number; readonly setNow: (now: number) => void }

export type AgeWatch = { readonly now: Accessor<number>; readonly release: () => void }

export type AgeClock = {
  readonly watch: (at: number) => AgeWatch
  readonly pause: () => void
  readonly resume: () => void
  readonly dispose: () => void
}

type Wake = { readonly at: (time: number) => void; readonly cancel: () => void; readonly target: () => number }

function createWake(run: () => void): Wake {
  let timer: ReturnType<typeof setTimeout> | undefined
  let target = Infinity
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    target = Infinity
  }
  const at = (time: number) => {
    cancel()
    if (time === Infinity) return
    target = time
    timer = setTimeout(() => {
      cancel()
      run()
    }, Math.max(0, time - Date.now()))
  }
  return { at, cancel, target: () => target }
}

function soonest(readers: ReadonlySet<Reader>): number {
  let next = Infinity
  for (const reader of readers) next = Math.min(next, reader.next)
  return next
}

function moveDueReaders(readers: ReadonlySet<Reader>, now: number) {
  for (const reader of readers) {
    if (reader.next > now) continue
    reader.next = nextAgeChange(reader.at, now)
    reader.setNow(now)
  }
}

export function createAgeClock(): AgeClock {
  const readers = new Set<Reader>()
  let paused = false
  const schedule = () => (paused ? wake.cancel() : wake.at(soonest(readers)))
  const advance = () => {
    moveDueReaders(readers, Date.now())
    schedule()
  }
  const wake = createWake(advance)
  const watch = (at: number): AgeWatch => {
    const [now, setNow] = createSignal(Date.now())
    const reader: Reader = { at, next: nextAgeChange(at, now()), setNow }
    readers.add(reader)
    if (!paused && reader.next < wake.target()) wake.at(reader.next)
    const release = () => {
      if (readers.delete(reader)) schedule()
    }
    return { now, release }
  }
  const pause = () => {
    paused = true
    wake.cancel()
  }
  const resume = () => {
    paused = false
    advance()
  }
  const dispose = () => {
    readers.clear()
    wake.cancel()
  }
  return { watch, pause, resume, dispose }
}
