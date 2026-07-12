import { describe, expect, test, vi } from "bun:test"
import { setupDropHandler, setupCopyHandler, setupPasteHandler } from "./clipboard"

// ---------------------------------------------------------------------------
// Drop handler
// ---------------------------------------------------------------------------

type DropDataTransfer = {
  files?: File[]
  getData: (type: string) => string
  dropEffect?: string
}

function dropEvent(dataTransfer: DropDataTransfer | null): {
  event: Event
  prevented: () => boolean
  stopped: () => boolean
} {
  let prevented = false
  let stopped = false
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
  event.preventDefault = () => {
    prevented = true
  }
  event.stopPropagation = () => {
    stopped = true
  }
  return { event, prevented: () => prevented, stopped: () => stopped }
}

function fakeContainer() {
  const el = document.createElement("div")
  return {
    el,
    dispatch: (_type: string, event: Event) => el.dispatchEvent(event),
  }
}

describe("setupDropHandler", () => {
  test("files-only drop (Chrome/web) does NOT stopPropagation — event bubbles to global handler", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({}, container.el, { onWrite })

    // Simulate Chrome-on-macOS Finder drop: Files present but no text/uri-list
    const dt = {
      files: [new File(["hello"], "image.png", { type: "image/png" })],
      getData: () => "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///Users/me/photo.png" : "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, {
      onWrite,
      isBracketedPasteEnabled: () => true,
    })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///tmp/test.txt" : "",
    }
    const e = dropEvent(dt)
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
    const prev = Reflect.get(window, "api")
    const api = {
      getDroppedFilePaths: (files: File[]) =>
        files.map(() => "/Users/me/dropped.txt"),
    }
    Reflect.set(window, "api", api)

    try {
      setupDropHandler({}, container.el, { onWrite })

      const dt = {
        files: [new File(["content"], "dropped.txt")],
        getData: () => "",
      }
      const e = dropEvent(dt)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(e.prevented()).toBe(true)
      expect(e.stopped()).toBe(true)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite.mock.calls[0][0]).toContain("/Users/me/dropped.txt")
    } finally {
      Reflect.set(window, "api", prev)
    }
  })

  test("Electron image drop for agent terminals writes clipboard image then sends Ctrl+V", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = Reflect.get(window, "api")
    const api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/image.png"]),
      writeClipboardImage: vi.fn(async () => true),
    }
    Reflect.set(window, "api", api)

    try {
      setupDropHandler({}, container.el, { image: "paste", onWrite })

      const dt = {
        files: [new File(["png"], "image.png", { type: "image/png" })],
        getData: () => "",
      }
      const e = dropEvent(dt)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(e.prevented()).toBe(true)
      expect(e.stopped()).toBe(true)
      expect(api.writeClipboardImage).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledWith("\x16")
      expect(api.getDroppedFilePaths).not.toHaveBeenCalled()
    } finally {
      Reflect.set(window, "api", prev)
    }
  })

  test("multiple dropped images send one Ctrl+V per image", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = Reflect.get(window, "api")
    const api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/1.png", "/Users/me/2.png"]),
      writeClipboardImage: vi.fn(async () => true),
    }
    Reflect.set(window, "api", api)

    try {
      setupDropHandler({}, container.el, { image: "paste", onWrite })

      const dt = {
        files: [
          new File(["one"], "1.png", { type: "image/png" }),
          new File(["two"], "2.png", { type: "image/png" }),
        ],
        getData: () => "",
      }
      const e = dropEvent(dt)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(api.writeClipboardImage).toHaveBeenCalledTimes(2)
      expect(onWrite).toHaveBeenCalledTimes(2)
      expect(onWrite.mock.calls).toEqual([["\x16"], ["\x16"]])
      expect(api.getDroppedFilePaths).not.toHaveBeenCalled()
    } finally {
      Reflect.set(window, "api", prev)
    }
  })

  test("agent image drop falls back to path paste if clipboard write fails", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()
    const prev = Reflect.get(window, "api")
    const api = {
      getDroppedFilePaths: vi.fn(() => ["/Users/me/fallback.png"]),
      writeClipboardImage: vi.fn(async () => false),
    }
    Reflect.set(window, "api", api)

    try {
      setupDropHandler({}, container.el, { image: "paste", onWrite })

      const dt = {
        files: [new File(["png"], "fallback.png", { type: "image/png" })],
        getData: () => "",
      }
      const e = dropEvent(dt)
      container.dispatch("drop", e.event)

      await new Promise((r) => setTimeout(r, 10))

      expect(api.writeClipboardImage).toHaveBeenCalledTimes(1)
      expect(api.getDroppedFilePaths).toHaveBeenCalledTimes(1)
      expect(onWrite).toHaveBeenCalledTimes(1)
      expect(onWrite.mock.calls[0][0]).toContain("/Users/me/fallback.png")
    } finally {
      Reflect.set(window, "api", prev)
    }
  })

  test("empty dataTransfer does not stopPropagation", async () => {
    const onWrite = vi.fn()
    const container = fakeContainer()

    setupDropHandler({}, container.el, { onWrite })

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
  const element = document.createElement("div")
  return {
    terminal: {
      getSelection: () => selection,
      element,
    },
    dispatch: (_type: string, event: Event) => element.dispatchEvent(event),
  }
}

describe("setupCopyHandler", () => {
  test("does NOT call preventDefault when clipboardData is null (Wayland/Linux)", () => {
    const term = fakeXtermForCopy("hello world")
    setupCopyHandler(term.terminal)

    let prevented = false
    const event = new Event("copy", { cancelable: true })
    Object.defineProperty(event, "clipboardData", { value: null })
    event.preventDefault = () => {
      prevented = true
    }

    term.dispatch("copy", event)

    expect(prevented).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Paste handler — non-text clipboard content
// ---------------------------------------------------------------------------

function fakeXtermForPaste() {
  const textarea = document.createElement("textarea")
  return {
    terminal: {
      textarea,
      paste: vi.fn(),
    },
    dispatch: (_type: string, event: Event) => textarea.dispatchEvent(event),
  }
}

describe("setupPasteHandler non-text clipboard", () => {
  test("forwards Ctrl+V (0x16) when clipboard contains only non-text content", () => {
    const onWrite = vi.fn()
    const term = fakeXtermForPaste()
    setupPasteHandler(term.terminal, { onWrite })

    const event = new Event("paste", { cancelable: true })
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["image/png"],
        getData: (type: string) => (type === "text/plain" ? "" : ""),
      },
    })
    event.stopImmediatePropagation = () => {}

    term.dispatch("paste", event)

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

    setupDropHandler({}, container.el, { onWrite })

    // Windows file URIs: file:///C:/Users/me/file.txt
    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///C:/Users/me/file.txt" : "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///d:/dev/project/main.rs" : "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///C:/Program%20Files/My%20App/config.json" : "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, { onWrite })

    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list"
          ? "file:///C:/Users/me/a.txt\r\nfile:///D:/dev/b.txt"
          : "",
    }
    const e = dropEvent(dt)
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

    setupDropHandler({}, container.el, { onWrite })

    // Unix: file:///home/user/file.txt — no drive letter after the third slash
    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///home/user/file.txt" : "",
    }
    const e = dropEvent(dt)
    container.dispatch("drop", e.event)

    await new Promise((r) => setTimeout(r, 10))

    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite.mock.calls[0][0]).toContain("/home/user/file.txt")
  })
})
