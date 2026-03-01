import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"

const h = vi.hoisted(() => {
  class MockTextSelection {
    from: number
    to: number
    empty: boolean
    constructor(_doc: unknown, from: number, to = from) {
      this.from = from
      this.to = to
      this.empty = from === to
    }
    static create(doc: unknown, from: number, to = from) {
      return new MockTextSelection(doc, from, to)
    }
  }
  return {
    MockTextSelection,
    api: {
      get: vi.fn(),
      update: vi.fn(),
      ai: vi.fn(),
      importMarkdown: vi.fn(),
      syncMarkdown: vi.fn(),
      exportMarkdown: vi.fn(),
    },
    setSelection: (_from: number, _to: number) => {},
    emitEditor: (_event: string, _payload?: unknown) => {},
    setEmpty: (_empty: boolean) => {},
    sync: {
      data: {
        message: {} as Record<string, Array<{ id: string; role: string }>>,
        todo: {} as Record<string, unknown[]>,
        question: {} as Record<string, unknown[]>,
        permission: {} as Record<string, Array<{ id: string }>>,
      },
      session: {
        get: vi.fn(),
        sync: vi.fn(),
      },
    },
    permissionRespond: vi.fn(),
    createSession: vi.fn(async () => ({ data: { id: "ses-page-1" } })),
  }
})

vi.mock("@tiptap/pm/state", () => ({
  TextSelection: h.MockTextSelection,
  Transaction: class {
    mapping = { map: (pos: number) => pos }
  },
}))

vi.mock("solid-tiptap", () => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>()
  const doc = {
    content: { size: 120 },
    textBetween: (from: number, to: number) => (from < to ? `selected(${from}-${to})` : ""),
    forEach: (cb: (node: { nodeSize: number }, pos: number) => void) => cb({ nodeSize: 120 }, 0),
    descendants: (_cb: (node: { type: { name: string }; attrs?: { level?: number }; textContent: string }, pos: number) => boolean) => true,
  }
  const editor = {
    state: {
      selection: new h.MockTextSelection(doc, 1, 1),
      doc,
      tr: {
        setSelection: () => editor.state.tr,
        scrollIntoView: () => editor.state.tr,
      },
    },
    view: {
      dom: document.createElement("div"),
      dispatch: vi.fn(),
      coordsAtPos: (_pos: number) => ({ left: 220, right: 220, top: 300, bottom: 320 }),
    },
    on: (event: string, cb: (payload?: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
    },
    off: (event: string, cb: (payload?: unknown) => void) => {
      listeners.get(event)?.delete(cb)
    },
    chain: () => {
      const chain = new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop === "run") return () => true
            return () => chain
          },
        },
      )
      return chain
    },
    commands: {
      focus: vi.fn(),
    },
    getText: () => "full doc context",
    isActive: () => false,
    getAttributes: () => ({}),
    isEmpty: true,
  }
  h.setEmpty = (value: boolean) => {
    editor.isEmpty = value
  }
  h.setSelection = (from: number, to: number) => {
    editor.state.selection = new h.MockTextSelection(doc, from, to)
  }
  h.emitEditor = (event: string, payload?: unknown) => {
    listeners.get(event)?.forEach((cb) => cb(payload))
  }
  return {
    createTiptapEditor: () => () => editor,
    useEditorJSON: () => () => undefined,
  }
})

vi.mock("./slash-commands", () => ({
  SlashCommands: {},
}))

vi.mock("../../utils/pages-api", () => ({
  pagesApi: h.api,
}))

vi.mock("@opencode-ai/claxedo-app", () => ({
  useSync: () => h.sync,
  useGlobalSDK: () => ({
    client: {
      session: {
        create: h.createSession,
      },
    },
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/context/prompt", () => ({
  usePrompt: () => ({ ready: () => true }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    client: {
      permission: {
        respond: h.permissionRespond,
      },
    },
  }),
}))

vi.mock("@opencode-ai/ui/session-turn", () => ({
  SessionTurn: () => <div data-testid="session-turn" />,
}))

vi.mock("./compact-prompt-dock", () => ({
  CompactPromptDock: (props: { messages?: unknown }) => <div data-testid="compact-dock">{props.messages as any}</div>,
}))

import { TabPage } from "./tab-page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

beforeEach(() => {
  h.setEmpty(true)
  h.sync.session.get.mockReturnValue(undefined)
  h.sync.session.sync.mockResolvedValue(undefined)
  h.sync.data.message = {}
  h.sync.data.todo = {}
  h.sync.data.question = {}
  h.sync.data.permission = {}
  h.permissionRespond.mockReset()
  h.createSession.mockClear()
  h.api.get.mockResolvedValue({
    id: "p-1",
    title: "Page",
    content: "{}",
  })
  h.api.update.mockResolvedValue({ id: "p-1", title: "Page", content: "{}" })
  h.api.ai.mockResolvedValue({ text: "Updated text from AI." })
  h.api.importMarkdown.mockResolvedValue({
    page: { id: "p-1", title: "Page", content: "{}" },
    imported: true,
    conflict: false,
  })
  h.api.syncMarkdown.mockResolvedValue({
    page: { id: "p-1", title: "Page", content: "{}" },
    imported: false,
    conflict: false,
  })
  h.api.exportMarkdown.mockResolvedValue({
    id: "p-1",
    title: "Page",
    markdown: "# Page",
    meta: {
      page_id: "p-1",
      updated_at: "2026-01-01T00:00:00.000Z",
      doc_hash: "x",
      md_export_hash: "y",
      md_export_base_doc_hash: "x",
      derived_markdown: true,
    },
  })
})

function mockIndexedDB(seed: Array<{ page_id: string; value: unknown }> = []) {
  const stores = new Map<string, Map<string, unknown>>()
  if (seed.length) stores.set("links", new Map(seed.map((item) => [item.page_id, item.value])))
  let opened = false
  const request = (result: unknown) => {
    const req = {} as {
      result?: unknown
      onsuccess?: (event: unknown) => void
      onerror?: (event: unknown) => void
      onupgradeneeded?: (event: unknown) => void
    }
    queueMicrotask(() => {
      req.result = result
      req.onsuccess?.({ target: req })
    })
    return req
  }
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const map = stores.get(name)!
    return {
      get: (key: string) => request(map.get(key)),
      put: (value: { page_id?: string }) => {
        if (value?.page_id) map.set(value.page_id, value)
        return request(undefined)
      },
      delete: (key: string) => {
        map.delete(key)
        return request(undefined)
      },
    }
  }
  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string) => store(name),
    transaction: (name: string, _mode: string) => ({
      objectStore: () => store(name),
    }),
  }
  return {
    open: (_name: string, _version: number) => {
      const req = {} as {
        result?: unknown
        onsuccess?: (event: unknown) => void
        onerror?: (event: unknown) => void
        onupgradeneeded?: (event: unknown) => void
      }
      queueMicrotask(() => {
        req.result = db
        if (!opened) {
          opened = true
          req.onupgradeneeded?.({ target: req })
        }
        req.onsuccess?.({ target: req })
      })
      return req
    },
  }
}

describe("TabPage integration", () => {
  test("shows empty-page import markdown button", async () => {
    render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))
    expect(screen.getByRole("button", { name: "Import Markdown" })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Import Markdown" })).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Sync Markdown" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Export Markdown" })).not.toBeInTheDocument()
  })

  test("selection -> toolbar -> ai menu (anchored) -> preview", async () => {
    vi.useFakeTimers()
    const { container } = render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))

    h.setSelection(5, 15)
    h.emitEditor("selectionUpdate")

    await waitFor(() => expect(container.querySelector(".notion-floating-toolbar")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }))

    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())
    expect(container.querySelector(".notion-floating-toolbar")).not.toBeInTheDocument()

    const menu = container.querySelector(".notion-ai-menu") as HTMLElement
    expect(menu.style.left).toBe("10px")
    expect(menu.style.top).toBe("332px")

    fireEvent.click(screen.getByRole("button", { name: "Continue writing" }))
    await waitFor(() => expect(h.api.ai).toHaveBeenCalled())
    await vi.runAllTimersAsync()

    await waitFor(() => expect(container.querySelector(".notion-ai-preview")).toBeInTheDocument())
    expect(container.querySelector(".notion-ai-menu")).not.toBeInTheDocument()
  })

  test("opens AI composer from slash bridge event", async () => {
    const { container } = render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))
    h.setSelection(1, 1)
    window.dispatchEvent(new CustomEvent("claxedo-page-ai-open"))
    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())
    expect(container.querySelector(".notion-floating-toolbar")).not.toBeInTheDocument()
    expect(container.querySelector(".notion-ai-menu-list")).not.toBeInTheDocument()
  })

  test("closing and reopening ask ai resets composer input and logs", async () => {
    const { container } = render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))
    h.setSelection(1, 1)
    window.dispatchEvent(new CustomEvent("claxedo-page-ai-open"))
    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())

    const input = container.querySelector(".notion-ai-prompt-input") as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Rewrite this" } })
    fireEvent.click(screen.getByRole("button", { name: "↑" }))

    await waitFor(() => expect(h.api.ai).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector(".notion-ai-preview")).toBeInTheDocument())

    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(container.querySelector(".notion-ai-preview")).not.toBeInTheDocument())

    window.dispatchEvent(new CustomEvent("claxedo-page-ai-open"))
    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())
    const reopened = container.querySelector(".notion-ai-prompt-input") as HTMLTextAreaElement
    expect(reopened.value).toBe("")
    expect(container.querySelector(".notion-ai-runlog")).not.toBeInTheDocument()
  })

  test("cached selection is used after live selection collapses", async () => {
    vi.useFakeTimers()
    render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))

    h.setSelection(7, 13)
    h.emitEditor("selectionUpdate")
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask AI" })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Improve writing" })).toBeInTheDocument())

    h.setSelection(7, 7)
    h.emitEditor("selectionUpdate")

    const improve = screen.getByRole("button", { name: "Improve writing" }) as HTMLButtonElement
    expect(improve.disabled).toBe(false)
    fireEvent.click(improve)
    await waitFor(() => expect(h.api.ai).toHaveBeenCalled())
    expect(h.api.ai).toHaveBeenCalledWith(expect.objectContaining({ action: "improve", text: "selected(7-13)" }))

    await vi.runAllTimersAsync()
  })

  test("imports markdown with force=true on first link import", async () => {
    const original = document.createElement.bind(document)
    const file = {
      name: "doc.md",
      text: async () => "# Imported",
    }
    const create = vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const node = original(tagName)
      if (tagName.toLowerCase() !== "input") return node
      const input = node as HTMLInputElement
      Object.defineProperty(input, "files", {
        configurable: true,
        get: () => [file],
      })
      input.click = () => {
        input.onchange?.(new Event("change"))
      }
      return input
    })
    render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))
    fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }))
    await waitFor(() => expect(h.api.importMarkdown).toHaveBeenCalledWith("p-1", "# Imported", true))
    create.mockRestore()
  })

  test("linked markdown auto-pulls when file changed and page hash is unchanged", async () => {
    const handle = {
      name: "linked.md",
      queryPermission: vi.fn(async () => "granted" as PermissionState),
      requestPermission: vi.fn(async () => "granted" as PermissionState),
      getFile: vi.fn(async () => ({ name: "linked.md", text: async () => "# v2" })),
    }
    const originalDb = window.indexedDB
    ;(window as Window & { indexedDB: IDBFactory }).indexedDB = mockIndexedDB([
      {
        page_id: "p-1",
        value: {
          page_id: "p-1",
          handle,
          name: "linked.md",
          doc_hash: "doc-hash-1",
          file_hash: "stale-file-hash",
          updated_at: Date.now(),
        },
      },
    ]) as unknown as IDBFactory
    h.api.exportMarkdown.mockImplementation(async () => ({
      id: "p-1",
      title: "Page",
      markdown: "# Page",
      meta: {
        page_id: "p-1",
        updated_at: "2026-01-01T00:00:00.000Z",
        doc_hash: "doc-hash-1",
        md_export_hash: "md-export-hash",
        md_export_base_doc_hash: "doc-hash-1",
        derived_markdown: true,
      },
    }))

    render(() => <TabPage pageId="p-1" />)
    await waitFor(() => expect(h.api.importMarkdown).toHaveBeenCalledWith("p-1", "# v2", false))
    ;(window as Window & { indexedDB: IDBFactory }).indexedDB = originalDb
  })

  test("shows sync action when linked file and page both changed (conflict)", async () => {
    const handle = {
      name: "linked.md",
      queryPermission: vi.fn(async () => "granted" as PermissionState),
      requestPermission: vi.fn(async () => "granted" as PermissionState),
      getFile: vi.fn(async () => ({ name: "linked.md", text: async () => "# v2" })),
    }
    const originalDb = window.indexedDB
    ;(window as Window & { indexedDB: IDBFactory }).indexedDB = mockIndexedDB([
      {
        page_id: "p-1",
        value: {
          page_id: "p-1",
          handle,
          name: "linked.md",
          doc_hash: "doc-hash-old",
          file_hash: "stale-file-hash",
          updated_at: Date.now(),
        },
      },
    ]) as unknown as IDBFactory
    h.api.exportMarkdown.mockImplementation(async () => ({
      id: "p-1",
      title: "Page",
      markdown: "# Page",
      meta: {
        page_id: "p-1",
        updated_at: "2026-01-01T00:00:00.000Z",
        doc_hash: "doc-hash-new",
        md_export_hash: "md-export-hash",
        md_export_base_doc_hash: "doc-hash-new",
        derived_markdown: true,
      },
    }))

    h.setEmpty(false)
    render(() => <TabPage pageId="p-1" />)
    const sync = await screen.findByRole("button", { name: "Sync Markdown" })
    expect(sync).toBeInTheDocument()
    fireEvent.click(sync)
    await waitFor(() => expect(h.api.importMarkdown).toHaveBeenCalledWith("p-1", "# v2", false))
    ;(window as Window & { indexedDB: IDBFactory }).indexedDB = originalDb
  })
})
