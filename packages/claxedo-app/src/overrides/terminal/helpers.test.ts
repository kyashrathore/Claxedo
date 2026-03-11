import { describe, expect, test, vi, mock } from "bun:test"
import { setupKeyboardHandler, setupDropHandler } from "./helpers"

const invoke = vi.fn()

mock.module("@tauri-apps/api/core", () => ({
  invoke,
}))

function key(input: { key: string; metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) {
  let prevented = false
  let stopped = false
  const event = {
    type: "keydown",
    key: input.key,
    metaKey: !!input.metaKey,
    shiftKey: !!input.shiftKey,
    ctrlKey: !!input.ctrlKey,
    altKey: !!input.altKey,
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {
      stopped = true
    },
  } as unknown as KeyboardEvent
  return {
    event,
    prevented: () => prevented,
    stopped: () => stopped,
  }
}

function xterm() {
  const state = { fn: ((_: KeyboardEvent) => true) as (event: KeyboardEvent) => boolean }
  return {
    state,
    terminal: {
      attachCustomKeyEventHandler: (fn: (event: KeyboardEvent) => boolean) => {
        state.fn = fn
      },
    },
  }
}

describe("setupKeyboardHandler split shortcuts", () => {
  test("Cmd+D intercepts and blocks bubbling", () => {
    const split = vi.fn()
    const term = xterm()
    setupKeyboardHandler(term.terminal as never, { onSplitVertical: split })
    const e = key({ key: "d", metaKey: true })
    const result = term.state.fn(e.event)

    expect(result).toBe(false)
    expect(split).toHaveBeenCalledTimes(1)
    expect(e.prevented()).toBe(true)
    expect(e.stopped()).toBe(true)
  })

  test("Cmd+Shift+D intercepts even when key is uppercase", () => {
    const split = vi.fn()
    const term = xterm()
    setupKeyboardHandler(term.terminal as never, { onSplitHorizontal: split })
    const e = key({ key: "D", metaKey: true, shiftKey: true })
    const result = term.state.fn(e.event)

    expect(result).toBe(false)
    expect(split).toHaveBeenCalledTimes(1)
    expect(e.prevented()).toBe(true)
    expect(e.stopped()).toBe(true)
  })

})

// ---------------------------------------------------------------------------
// Drop handler
// ---------------------------------------------------------------------------

function dropEvent(dataTransfer: Partial<DataTransfer> | null): {
  event: DragEvent
  prevented: () => boolean
  stopped: () => boolean
} {
  let prevented = false
  let stopped = false
  const event = {
    type: "drop",
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {
      stopped = true
    },
    dataTransfer,
  } as unknown as DragEvent
  return { event, prevented: () => prevented, stopped: () => stopped }
}

function fakeContainer() {
  const listeners: Record<string, EventListener> = {}
  return {
    el: {
      addEventListener: (type: string, fn: EventListener) => {
        listeners[type] = fn
      },
      removeEventListener: () => {},
    } as unknown as HTMLDivElement,
    dispatch: (type: string, event: Event) => listeners[type]?.(event),
  }
}

describe("setupDropHandler", () => {
  test("files-only Tauri drop saves file and writes escaped path", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = (window as any).__TAURI__

    invoke.mockReset()
    invoke.mockResolvedValue("/tmp/image.png")
    ;(window as any).__TAURI__ = {}

    try {
      setupDropHandler({} as never, container.el, { onWrite })

      const dt = {
        files: [new File(["hello"], "image.png", { type: "image/png" })],
        getData: () => "",
      }
      const e = dropEvent(dt as unknown as DataTransfer)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(e.prevented()).toBe(true)
      expect(e.stopped()).toBe(true)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(
        "save_dropped_file",
        expect.objectContaining({
          name: "image.png",
        }),
      )
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite.mock.calls[0][0]).toContain("/tmp/image.png")
    } finally {
      ;(window as any).__TAURI__ = prev
    }
  })

  test("files-only drop (Chrome/web) does NOT stopPropagation — event bubbles to global handler", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    // Simulate Chrome-on-macOS Finder drop: Files present but no text/uri-list
    const dt = {
      files: [new File(["hello"], "image.png", { type: "image/png" })],
      getData: () => "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    // Let any microtasks settle
    await new Promise((r) => setTimeout(r, 10))

    expect(e.prevented()).toBe(true) // always prevent browser navigation
    expect(e.stopped()).toBe(false) // must NOT stop — let it reach document handler
    expect(onWrite).not.toHaveBeenCalled()
  })

  test("file:// URI drop calls stopPropagation and writes escaped path", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///Users/me/photo.png" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(e.prevented()).toBe(true)
    expect(e.stopped()).toBe(true)
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite.mock.calls[0][0]).toContain("/Users/me/photo.png")
  })

  test("file:// URI drop with bracketed paste wraps in escape sequences", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, {
      onWrite,
      isBracketedPasteEnabled: () => true,
    })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///tmp/test.txt" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    const written = onWrite.mock.calls[0][0]
    expect(written.startsWith("\x1b[200~")).toBe(true)
    expect(written.endsWith("\x1b[201~")).toBe(true)
    expect(written).toContain("/tmp/test.txt")
  })

  test("Electron drop uses getDroppedFilePaths and writes escaped path", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = (window as any).api

    ;(window as any).api = {
      getDroppedFilePaths: (files: File[]) =>
        files.map(() => "/Users/me/dropped.txt"),
    }

    try {
      setupDropHandler({} as never, container.el, { onWrite })

      const dt = {
        files: [new File(["content"], "dropped.txt")],
        getData: () => "",
      }
      const e = dropEvent(dt as unknown as DataTransfer)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(e.prevented()).toBe(true)
      expect(e.stopped()).toBe(true)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite.mock.calls[0][0]).toContain("/Users/me/dropped.txt")
    } finally {
      ;(window as any).api = prev
    }
  })

  test("empty dataTransfer does not stopPropagation", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    const e = dropEvent(null)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(e.stopped()).toBe(false)
    expect(onWrite).not.toHaveBeenCalled()
  })
})
