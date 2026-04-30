import { describe, expect, test, vi } from "bun:test"
import { setupKeyboardHandler, setupDropHandler, setupCopyHandler, setupPasteHandler } from "./helpers"

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

  test("Electron image drop for agent terminals writes clipboard image then sends Ctrl+V", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = (window as any).api

    ;(window as any).api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/image.png"]),
      writeClipboardImage: vi.fn(async () => true),
    }

    try {
      setupDropHandler({} as never, container.el, { image: "paste", onWrite })

      const dt = {
        files: [new File(["png"], "image.png", { type: "image/png" })],
        getData: () => "",
      }
      const e = dropEvent(dt as unknown as DataTransfer)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(e.prevented()).toBe(true)
      expect(e.stopped()).toBe(true)
      expect((window as any).api.writeClipboardImage).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledWith("\x16")
      expect((window as any).api.getDroppedFilePaths).not.toHaveBeenCalled()
    } finally {
      ;(window as any).api = prev
    }
  })

  test("multiple dropped images send one Ctrl+V per image", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = (window as any).api

    ;(window as any).api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/1.png", "/Users/me/2.png"]),
      writeClipboardImage: vi.fn(async () => true),
    }

    try {
      setupDropHandler({} as never, container.el, { image: "paste", onWrite })

      const dt = {
        files: [
          new File(["one"], "1.png", { type: "image/png" }),
          new File(["two"], "2.png", { type: "image/png" }),
        ],
        getData: () => "",
      }
      const e = dropEvent(dt as unknown as DataTransfer)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect((window as any).api.writeClipboardImage).toHaveBeenCalledTimes(2)
      expect(onWrite).toHaveBeenCalledTimes(2)
      expect(onWrite.mock.calls).toEqual([["\x16"], ["\x16"]])
      expect((window as any).api.getDroppedFilePaths).not.toHaveBeenCalled()
    } finally {
      ;(window as any).api = prev
    }
  })

  test("agent image drop falls back to path paste if clipboard write fails", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = (window as any).api

    ;(window as any).api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/fallback.png"]),
      writeClipboardImage: vi.fn(async () => false),
    }

    try {
      setupDropHandler({} as never, container.el, { image: "paste", onWrite })

      const dt = {
        files: [new File(["png"], "fallback.png", { type: "image/png" })],
        getData: () => "",
      }
      const e = dropEvent(dt as unknown as DataTransfer)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect((window as any).api.writeClipboardImage).toHaveBeenCalledTimes(1)
      expect((window as any).api.getDroppedFilePaths).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite.mock.calls[0][0]).toContain("/Users/me/fallback.png")
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

// ---------------------------------------------------------------------------
// Copy handler
// ---------------------------------------------------------------------------

function fakeXtermForCopy(selection: string) {
  const listeners: Record<string, EventListener> = {}
  return {
    terminal: {
      getSelection: () => selection,
      element: {
        addEventListener: (type: string, fn: EventListener) => {
          listeners[type] = fn
        },
        removeEventListener: () => {},
      } as unknown as HTMLElement,
    } as unknown as Parameters<typeof setupCopyHandler>[0],
    dispatch: (type: string, event: Event) => listeners[type]?.(event),
  }
}

// RED — current code calls event.preventDefault() unconditionally before
// checking whether clipboardData is present. On Wayland/Linux clipboardData
// is null, so preventDefault() kills the native copy AND the async
// navigator.clipboard fallback fires but the test still catches the early
// unconditional call.
describe("setupCopyHandler", () => {
  test("does NOT call preventDefault when clipboardData is null (Wayland/Linux)", () => {
    const term = fakeXtermForCopy("hello world")
    setupCopyHandler(term.terminal)

    let prevented = false
    const event = {
      type: "copy",
      clipboardData: null,
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {},
    } as unknown as ClipboardEvent

    term.dispatch("copy", event)

    // Bug: current code calls event.preventDefault() before the
    // `if (event.clipboardData)` branch, so prevented is true.
    // Fix should make prevented remain false when clipboardData is null.
    expect(prevented).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Paste handler — non-text clipboard content
// ---------------------------------------------------------------------------

function fakeXtermForPaste() {
  const listeners: Record<string, EventListener> = {}
  return {
    terminal: {
      textarea: {
        addEventListener: (type: string, fn: EventListener, _opts?: unknown) => {
          listeners[type] = fn
        },
        removeEventListener: () => {},
      } as unknown as HTMLTextAreaElement,
      paste: vi.fn(),
    } as unknown as Parameters<typeof setupPasteHandler>[0],
    dispatch: (type: string, event: Event) => listeners[type]?.(event),
  }
}

// RED — current code has `if (!text) return` with no fallback, so when the
// clipboard holds only an image the handler exits silently.
// Expected behaviour (iTerm2/Ghostty): forward \x16 (Ctrl+V) to the PTY so
// the application can decide what to do with it.
describe("setupPasteHandler non-text clipboard", () => {
  test("forwards Ctrl+V (0x16) when clipboard contains only non-text content", () => {
    const onWrite = vi.fn()
    const term = fakeXtermForPaste()
    setupPasteHandler(term.terminal, { onWrite })

    const event = {
      type: "paste",
      clipboardData: {
        types: ["image/png"],
        getData: (type: string) => (type === "text/plain" ? "" : ""),
      },
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    } as unknown as ClipboardEvent

    term.dispatch("paste", event)

    // Bug: handler returns early on empty text, so onWrite is never called.
    // Fix should call onWrite("\x16") for the non-text-content case.
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite).toHaveBeenCalledWith("\x16")
  })
})

// ---------------------------------------------------------------------------
// Windows file:// URI drop handling
// ---------------------------------------------------------------------------

describe("setupDropHandler Windows file URIs", () => {
  test("file:// URI with Windows drive letter strips leading slash", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    // Windows file URIs: file:///C:/Users/me/file.txt
    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///C:/Users/me/file.txt" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(e.prevented()).toBe(true)
    expect(e.stopped()).toBe(true)
    expect(onWrite).toHaveBeenCalledTimes(1)
    // shell-quote escapes colons (C\:/...), so check key path segments
    const written1 = onWrite.mock.calls[0][0]
    expect(written1).toContain("/Users/me/file.txt")
    // Should NOT start with / (drive letter prefix, not Unix root)
    expect(written1).not.toMatch(/^\/[A-Za-z]/)
  })

  test("file:// URI with lowercase Windows drive letter", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///d:/dev/project/main.rs" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    // shell-quote escapes colons, so check the path part after the drive
    const written2 = onWrite.mock.calls[0][0]
    expect(written2).toContain("/dev/project/main.rs")
  })

  test("file:// URI with percent-encoded Windows path (spaces)", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///C:/Program%20Files/My%20App/config.json" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    // decodeURIComponent should decode %20 to spaces, then shell-quote escapes them
    const written = onWrite.mock.calls[0][0]
    expect(written).toContain("Program Files")
    expect(written).toContain("My App")
  })

  test("multiple Windows file:// URIs in one drop", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list"
          ? "file:///C:/Users/me/a.txt\r\nfile:///D:/dev/b.txt"
          : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    const written = onWrite.mock.calls[0][0]
    expect(written).toContain("a.txt")
    expect(written).toContain("b.txt")
  })

  test("Unix file:// URI does not strip leading slash", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({} as never, container.el, { onWrite })

    // Unix: file:///home/user/file.txt — no drive letter after the third slash
    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///home/user/file.txt" : "",
    }
    const e = dropEvent(dt as unknown as DataTransfer)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite.mock.calls[0][0]).toContain("/home/user/file.txt")
  })
})

// ---------------------------------------------------------------------------
// Word navigation shortcuts (Option+Arrow on Mac)
// RED: these tests are expected to FAIL until the feature is implemented.
// setupKeyboardHandler currently has no branch for altKey+Arrow, so the
// handler returns true (falls through to xterm) and onWrite is never called.
// ---------------------------------------------------------------------------

describe("setupKeyboardHandler word navigation (Option+Arrow on Mac)", () => {
  test("Option+ArrowLeft sends ESC+b (word backward) on Mac", () => {
    // bun:test does not support vi.stubGlobal; override the property directly
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    })

    try {
      const onWrite = vi.fn()
      const term = xterm()
      setupKeyboardHandler(term.terminal as never, { onWrite })

      const e = key({ key: "ArrowLeft", altKey: true, metaKey: false, ctrlKey: false })
      term.state.fn(e.event)

      // RED: Option+ArrowLeft is not currently handled — this assertion will fail
      expect(onWrite).toHaveBeenCalledWith("\x1bb")
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "navigator", originalDescriptor)
      }
    }
  })

  test("Option+ArrowRight sends ESC+f (word forward) on Mac", () => {
    // bun:test does not support vi.stubGlobal; override the property directly
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    })

    try {
      const onWrite = vi.fn()
      const term = xterm()
      setupKeyboardHandler(term.terminal as never, { onWrite })

      const e = key({ key: "ArrowRight", altKey: true, metaKey: false, ctrlKey: false })
      term.state.fn(e.event)

      // RED: Option+ArrowRight is not currently handled — this assertion will fail
      expect(onWrite).toHaveBeenCalledWith("\x1bf")
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "navigator", originalDescriptor)
      }
    }
  })
})
