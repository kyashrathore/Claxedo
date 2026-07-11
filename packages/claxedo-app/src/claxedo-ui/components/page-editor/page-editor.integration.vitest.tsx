import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClientProvider } from "@tanstack/solid-query"
import { queryClient } from "../../../shared/query/query-client"

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
      listStatuses: vi.fn(),
      sessionPrompt: vi.fn(),
    },
    setSelection: (_from: number, _to: number) => {},
    emitEditor: (_event: string, _payload?: unknown) => {},
    listenerCount: (_event: string) => 0,
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
  h.listenerCount = (event: string) => listeners.get(event)?.size ?? 0
  return {
    createTiptapEditor: () => () => editor,
    useEditorJSON: () => () => undefined,
  }
})

vi.mock("./slash-commands", () => ({
  SlashCommands: {},
}))

vi.mock("@/shared/data/pages-api", () => ({
  pagesApi: h.api,
}))

vi.mock("@claxedo/app", () => ({
  useSync: () => h.sync,
  useGlobalSDK: () => ({
    client: {
      session: {
        create: h.createSession,
        prompt: h.api.sessionPrompt,
      },
    },
  }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      session: {
        create: h.createSession,
        prompt: h.api.sessionPrompt,
      },
    },
  }),
}))

vi.mock("../../../context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      session: {
        create: h.createSession,
        prompt: h.api.sessionPrompt,
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

vi.mock("../../../context/sdk", () => ({
  useSDK: () => ({
    client: {
      permission: {
        respond: h.permissionRespond,
      },
    },
  }),
}))

vi.mock("@/session-client", () => ({
  SessionTurn: () => <div data-testid="session-turn" />,
}))

import { TabPage } from "./tab-page"

async function renderPage() {
  const result = render(() => (
    <QueryClientProvider client={queryClient}>
      <TabPage pageId="p-1" sessionId="ses-page-1" />
    </QueryClientProvider>
  ))
  await waitFor(() => expect(h.api.get).toHaveBeenCalledWith("p-1"))
  await waitFor(() => expect(result.container.querySelector(".notion-editor")).toBeInTheDocument())
  await waitFor(() => expect(h.listenerCount("selectionUpdate")).toBeGreaterThan(0))
  return result
}

afterEach(() => {
  cleanup()
  queryClient.clear()
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
  h.api.listStatuses.mockResolvedValue([{ id: "draft", name: "draft", color: "#6b7280", position: 0, transitions: [] }])
  h.api.sessionPrompt.mockResolvedValue({
    data: {
      parts: [{ type: "text", text: "Updated text from AI." }],
    },
  })
})

describe("TabPage integration", () => {
  test("selection -> toolbar -> ai menu (anchored) -> preview", async () => {
    vi.useFakeTimers()
    const { container } = await renderPage()

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
    await waitFor(() => expect(h.api.sessionPrompt).toHaveBeenCalled())
    await vi.runAllTimersAsync()

    await waitFor(() => expect(container.querySelector(".notion-ai-preview")).toBeInTheDocument())
    expect(container.querySelector(".notion-ai-menu")).not.toBeInTheDocument()
  })

  test("opens AI composer from slash bridge event", async () => {
    const { container } = await renderPage()
    h.setSelection(1, 1)
    window.dispatchEvent(new CustomEvent("claxedo-page-ai-open"))
    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())
    expect(container.querySelector(".notion-floating-toolbar")).not.toBeInTheDocument()
    expect(container.querySelector(".notion-ai-menu-list")).not.toBeInTheDocument()
  })

  test("closing and reopening ask ai resets composer input and logs", async () => {
    const { container } = await renderPage()
    h.setSelection(1, 1)
    window.dispatchEvent(new CustomEvent("claxedo-page-ai-open"))
    await waitFor(() => expect(container.querySelector(".notion-ai-menu")).toBeInTheDocument())

    const input = container.querySelector(".notion-ai-prompt-input") as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Rewrite this" } })
    fireEvent.click(screen.getByRole("button", { name: "↑" }))

    await waitFor(() => expect(h.api.sessionPrompt).toHaveBeenCalled())
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
    await renderPage()

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
    await waitFor(() => expect(h.api.sessionPrompt).toHaveBeenCalled())
    expect(h.api.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "ses-page-1",
      parts: [expect.objectContaining({ text: expect.stringContaining('action:"improve"') })],
    }))
    expect(h.api.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      parts: [expect.objectContaining({ text: expect.stringContaining('context:"selected(7-13)"') })],
    }))

    await vi.runAllTimersAsync()
  })

})
