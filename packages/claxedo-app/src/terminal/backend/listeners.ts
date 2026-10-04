import type { TerminalSize } from "@/server"
import type { Disposer } from "@/shell"

export type BackendListeners = {
  readonly emitData: (data: string) => void
  readonly emitKey: (key: string) => void
  readonly emitResize: (cols: number, rows: number) => void
  readonly onData: (fn: (data: string) => void) => Disposer
  readonly onKey: (fn: (event: { key: string }) => void) => Disposer
  readonly onResize: (fn: (size: TerminalSize) => void) => Disposer
  readonly clear: () => void
}

function addListener<T>(set: Set<T>, fn: T): Disposer {
  set.add(fn)
  return () => set.delete(fn)
}

export function createListeners(): BackendListeners {
  const data = new Set<(data: string) => void>()
  const key = new Set<(event: { key: string }) => void>()
  const resize = new Set<(size: TerminalSize) => void>()
  return {
    emitData: (payload) => {
      for (const fn of data) fn(payload)
    },
    emitKey: (value) => {
      for (const fn of key) fn({ key: value })
    },
    emitResize: (cols, rows) => {
      for (const fn of resize) fn({ cols, rows })
    },
    onData: (fn) => addListener(data, fn),
    onKey: (fn) => addListener(key, fn),
    onResize: (fn) => addListener(resize, fn),
    clear: () => {
      data.clear()
      key.clear()
      resize.clear()
    },
  }
}
