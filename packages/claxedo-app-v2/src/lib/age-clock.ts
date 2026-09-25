import { createSignal, type Accessor } from "solid-js"
import { nextAgeChange } from "./relative-time"

type Reader = { readonly at: number; next: number; readonly setNow: (now: number) => void }

export type AgeClock = {
  readonly watch: (at: number) => { readonly now: Accessor<number>; readonly release: () => void }
  readonly pause: () => void
  readonly resume: () => void
  readonly dispose: () => void
}

export function createAgeClock(): AgeClock {
  const readers = new Set<Reader>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let target = Infinity
  let paused = false

  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    target = Infinity
  }
  const wakeAt = (at: number) => {
    cancel()
    if (paused || at === Infinity) return
    target = at
    timer = setTimeout(advance, Math.max(0, at - Date.now()))
  }
  const schedule = () => {
    let soonest = Infinity
    for (const reader of readers) soonest = Math.min(soonest, reader.next)
    wakeAt(soonest)
  }
  const advance = () => {
    timer = undefined
    const now = Date.now()
    for (const reader of readers) {
      if (reader.next > now) continue
      reader.next = nextAgeChange(reader.at, now)
      reader.setNow(now)
    }
    schedule()
  }

  const watch = (at: number) => {
    const now = Date.now()
    const [read, setNow] = createSignal(now)
    const reader: Reader = { at, next: nextAgeChange(at, now), setNow }
    readers.add(reader)
    if (reader.next < target) wakeAt(reader.next)
    return {
      now: read,
      release: () => {
        if (readers.delete(reader)) schedule()
      },
    }
  }

  return {
    watch,
    pause: () => {
      paused = true
      cancel()
    },
    resume: () => {
      paused = false
      advance()
    },
    dispose: () => {
      readers.clear()
      cancel()
    },
  }
}
