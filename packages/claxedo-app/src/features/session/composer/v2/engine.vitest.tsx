// Strangler parity harness (plan 2026-07-25-005, W2/T2.2 + W3/T3.1).
//
// Every behaviour below is asserted against BOTH engines through the one
// `ComposerEngine` contract, driving the REAL vendored controller on the
// controller side and the REAL `editor-actions.ts`/`popover-controller.ts` on the
// legacy side. The composer's own frame is not rendered: this owns the input
// engine, and the frame is covered by `core-composer-modes.spec.ts`.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { render, cleanup, waitFor } from "@solidjs/testing-library"

vi.mock("@/features/session/app-ports", () => ({
  useServer: () => ({ url: "http://localhost:4096" }),
}))

vi.mock("@/platform/persistence/persist", async () => {
  const { createStore } = await import("solid-js")
  return {
    Persist: {
      scoped: (...input: unknown[]) => JSON.stringify(input),
      serverScoped: (...input: unknown[]) => JSON.stringify(input),
      global: (...input: unknown[]) => JSON.stringify(input),
    },
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, () => true, () => true] as const,
  }
})

import { PromptProvider, usePrompt } from "@/features/session/providers/prompt"
import { renderPromptEditor } from "@/features/session/composer/ui/editor-serialization"
import { setCursorPosition } from "@/features/session/composer/ui/editor-dom"
import { createComposerEngine } from "@/features/session/composer/v2/engine"
import {
  normalizeComposerEngineKind,
  resolveComposerEngineKind,
  type ComposerEngine,
  type ComposerEngineKind,
} from "@/features/session/composer/v2/engine-contract"

const triggered: string[] = []
const submitted: string[] = []

type Harness = {
  engine: ComposerEngine
  editor: HTMLDivElement
  prompt: ReturnType<typeof usePrompt>
  text: () => string
  type: (value: string) => void
  typeAtCaret: (value: string) => void
  press: (value: string) => void
  key: (init: KeyboardEventInit) => KeyboardEvent
}

let harness!: Harness

let scopeCounter = 0
const nextScope = () => `/repo-${++scopeCounter}`

function Probe(props: { kind: ComposerEngineKind }) {
  const prompt = usePrompt()
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  // jsdom does not treat `contenteditable` as focusable, so without a tabindex
  // `editor.focus()` is a no-op and `document.activeElement` never points here —
  // which would let a focus-gated code path pass in the browser and no-op in this
  // harness (or the reverse). The tabindex makes the harness faithful.
  editor.tabIndex = 0
  document.body.appendChild(editor)
  const engine = createComposerEngine({
    kind: props.kind,
    editor: () => editor,
    prompt,
    imageAttachments: () => prompt.current().flatMap((part) => (part.type === "image" ? [part] : [])),
    queueScroll: () => undefined,
    comments: { all: () => [], replace: () => undefined },
    agents: () => [{ name: "reviewer" }, { name: "build", mode: "primary" }],
    recentFiles: () => ["src/recent.ts"],
    searchFilesAndDirectories: async (query) => [`src/${query}-hit.ts`],
    commandOptions: () => [
      { id: "model.choose", title: "Choose model", slash: "model" },
      { id: "session.new", title: "New session", slash: "new" },
    ],
    customCommands: () => [{ name: "deploy", description: "Ship it" }],
    triggerSlashCommand: (id) => triggered.push(id),
    documentDirectory: () => "/repo",
    listDocuments: async () => [
      {
        documentId: "doc-1",
        displayName: "Design notes",
        originKind: "managed",
        placementKind: "local",
        status: "ready",
      },
    ],
    documentMentionText: (document) => `claxedo://document/${document.documentId}`,
    pick: () => undefined,
    escBlur: () => false,
    stoppable: () => false,
    booting: () => false,
    working: () => false,
    blank: () => false,
    abort: () => undefined,
    handleSubmit: () => submitted.push("submit"),
  })
  engine.bindEditor(editor)

  const text = () =>
    prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")

  harness = {
    engine,
    editor,
    prompt,
    text,
    // "Typing" is the browser's job: put the characters in the DOM, place the
    // caret, then fire the same input notification the frame's onInput fires.
    type: (value: string) => {
      editor.textContent = value
      editor.focus()
      setCursorPosition(editor, value.length)
      engine.handleInput()
    },
    // Insert at wherever the caret actually is, the way a browser keystroke does,
    // so a mis-placed caret shows up as wrong TEXT rather than passing silently.
    typeAtCaret: (value: string) => {
      const selection = window.getSelection()!
      const range = selection.getRangeAt(0)
      const node = document.createTextNode(value)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      engine.handleInput()
    },
    // A real keystroke: the engine sees keydown FIRST and may swallow it (this is
    // the whole difference between how the two engines enter shell mode — legacy
    // does it on keydown, upstream's machine does it on the resulting input).
    press: (value: string) => {
      editor.focus()
      setCursorPosition(editor, editor.textContent?.length ?? 0)
      const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
      engine.handleKeyDown(event)
      if (event.defaultPrevented) return
      harness.type((editor.textContent ?? "") + value)
    },
    key: (init) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
      engine.handleKeyDown(event)
      return event
    },
  }
  return <div />
}

function mount(kind: ComposerEngineKind, directory = nextScope()) {
  const view = render(() => (
    <PromptProvider directory={directory}>
      <Probe kind={kind} />
    </PromptProvider>
  ))
  return { view, directory }
}

beforeEach(() => {
  triggered.length = 0
  submitted.length = 0
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe("composer engine flag", () => {
  test("defaults to the legacy engine and only an explicit opt-in flips it", () => {
    expect(resolveComposerEngineKind({})).toBe("legacy")
    expect(resolveComposerEngineKind({ stored: null, env: undefined })).toBe("legacy")
    expect(resolveComposerEngineKind({ env: "controller" })).toBe("controller")
    expect(resolveComposerEngineKind({ env: "v2" })).toBe("controller")
    // The per-browser override wins over the build env in BOTH directions, so a
    // flagged-on build can still be pinned back to legacy from one machine.
    expect(resolveComposerEngineKind({ stored: "legacy", env: "controller" })).toBe("legacy")
    expect(resolveComposerEngineKind({ stored: "controller", env: "legacy" })).toBe("controller")
    expect(normalizeComposerEngineKind("nonsense")).toBeUndefined()
  })

  test("builds exactly the requested engine", () => {
    createRoot((dispose) => {
      mount("legacy")
      expect(harness.engine.kind).toBe("legacy")
      dispose()
    })
    cleanup()
    createRoot((dispose) => {
      mount("controller")
      expect(harness.engine.kind).toBe("controller")
      dispose()
    })
  })
})

for (const kind of ["legacy", "controller"] as const) {
  describe(`composer engine parity (${kind})`, () => {
    let mounted!: ReturnType<typeof mount>
    beforeEach(() => {
      mounted = mount(kind)
    })

    test("typing persists the draft into the shared prompt store", async () => {
      harness.type("hello world")
      await waitFor(() => expect(harness.text()).toBe("hello world"))
      expect(harness.engine.popover()).toBe(null)
      expect(harness.engine.mode()).toBe("normal")
    })

    test("`!` enters shell mode without leaving the character behind — behavior 3", async () => {
      harness.press("!")
      await waitFor(() => expect(harness.engine.mode()).toBe("shell"))
      await waitFor(() => expect(harness.text()).toBe(""))
      expect(harness.editor.textContent).toBe("")
    })

    test("backspace on an empty shell editor returns to normal mode — behavior 3", async () => {
      harness.press("!")
      await waitFor(() => expect(harness.engine.mode()).toBe("shell"))
      harness.editor.focus()
      setCursorPosition(harness.editor, 0)
      const event = harness.key({ key: "Backspace" })
      await waitFor(() => expect(harness.engine.mode()).toBe("normal"))
      expect(event.defaultPrevented).toBe(true)
    })

    test("typing `@` opens the mention popover with agents and recent files", async () => {
      harness.type("@")
      await waitFor(() => expect(harness.engine.popover()).toBe("at"))
      await waitFor(() => expect(harness.engine.popoverView.atFlat().length).toBeGreaterThan(0))
      const options = harness.engine.popoverView.atFlat()
      // `build` is mode:"primary" and must not be offered as a mention.
      expect(options.filter((option) => option.type === "agent").map((option) => option.display)).toEqual(["reviewer"])
      expect(options.some((option) => option.type === "file" && option.path === "src/recent.ts")).toBe(true)
    })

    test("selecting a mention writes an inline pill part — behaviors 10, 11", async () => {
      harness.type("@")
      await waitFor(() => expect(harness.engine.popoverView.atFlat().length).toBeGreaterThan(0))
      const agent = harness.engine.popoverView.atFlat().find((option) => option.type === "agent")!
      harness.engine.popoverView.onAtSelect(agent)
      await waitFor(() =>
        expect(harness.prompt.current().some((part) => part.type === "agent" && part.name === "reviewer")).toBe(true),
      )
      expect(harness.text()).toContain("@reviewer")
      expect(harness.engine.popover()).toBe(null)
    })

    // The bug this pins: upstream's `store.addMention` writes `prompt` and `cursor`
    // unbatched, so an unbatched insertion leaves the caret BEFORE the trailing
    // space and the next keystroke yields "@reviewerplease". Text, not caret
    // offsets, is asserted — a caret assertion would not have caught it either.
    test("a mention leaves the caret after its trailing space — behavior 10", async () => {
      harness.type("@rev")
      await waitFor(() => expect(harness.engine.popoverView.atFlat().length).toBeGreaterThan(0))
      const agent = harness.engine.popoverView.atFlat().find((option) => option.type === "agent")!
      harness.engine.popoverView.onAtSelect(agent)
      await waitFor(() => expect(harness.text()).toBe("@reviewer "))
      harness.typeAtCaret("please take a look")
      await waitFor(() => expect(harness.text()).toBe("@reviewer please take a look"))
    })

    test("Escape closes an open popover and leaves mode and text alone — behavior 6", async () => {
      harness.type("@")
      await waitFor(() => expect(harness.engine.popover()).toBe("at"))
      const event = harness.key({ key: "Escape" })
      await waitFor(() => expect(harness.engine.popover()).toBe(null))
      expect(event.defaultPrevented).toBe(true)
      expect(harness.engine.mode()).toBe("normal")
      expect(harness.text()).toBe("@")
    })

    test("typing `/` opens the command popover listing builtins and custom commands", async () => {
      harness.type("/")
      await waitFor(() => expect(harness.engine.popover()).toBe("slash"))
      await waitFor(() => expect(harness.engine.popoverView.slashFlat().length).toBeGreaterThan(0))
      const triggers = harness.engine.popoverView.slashFlat().map((command) => command.trigger)
      expect(triggers).toContain("model")
      expect(triggers).toContain("deploy")
      expect(triggers).toContain("docs")
    })

    test("a builtin command fires immediately and clears the editor — behavior 1", async () => {
      harness.type("/model")
      await waitFor(() => expect(harness.engine.popoverView.slashFlat().length).toBeGreaterThan(0))
      const model = harness.engine.popoverView.slashFlat().find((command) => command.id === "model.choose")!
      harness.engine.popoverView.onSlashSelect(model)
      await waitFor(() => expect(triggered).toEqual(["model.choose"]))
      await waitFor(() => expect(harness.text()).toBe(""))
      expect(harness.engine.popover()).toBe(null)
    })

    test("a custom command inserts its trigger for editing instead of firing — behavior 2", async () => {
      harness.type("/dep")
      await waitFor(() => expect(harness.engine.popoverView.slashFlat().length).toBeGreaterThan(0))
      const deploy = harness.engine.popoverView.slashFlat().find((command) => command.id === "custom.deploy")!
      harness.engine.popoverView.onSlashSelect(deploy)
      await waitFor(() => expect(harness.text()).toBe("/deploy "))
      expect(triggered).toEqual([])
    })

    test("the Documents command opens the document picker on the `@` surface", async () => {
      harness.type("/docs")
      await waitFor(() => expect(harness.engine.popoverView.slashFlat().length).toBeGreaterThan(0))
      const documents = harness.engine.popoverView.slashFlat().find((command) => command.id === "documents.open")!
      harness.engine.popoverView.onSlashSelect(documents)
      await waitFor(() => expect(harness.engine.documentPicker.open()).toBe(true))
      await waitFor(() => expect(harness.engine.popover()).toBe("at"))
      await waitFor(() => expect(harness.engine.popoverView.atFlat().length).toBe(1))
      const document = harness.engine.popoverView.atFlat()[0]!
      expect(document).toMatchObject({ type: "document", documentId: "doc-1", status: "ready" })
      harness.engine.popoverView.onAtSelect(document)
      await waitFor(() => expect(harness.text()).toBe("claxedo://document/doc-1"))
      expect(harness.engine.documentPicker.open()).toBe(false)
    })

    // Constraint from the `+` menu that landed 2026-07-25: focus is deliberately
    // NOT handed to the editor, so the surface has to survive the menu's blur.
    // Both entries must open their list and STAY open across that blur.
    test("the `+` menu opens both popovers and they survive the menu's blur", async () => {
      harness.engine.openPopover("slash")
      await waitFor(() => expect(harness.engine.popover()).toBe("slash"))
      await waitFor(() => expect(harness.engine.popoverView.slashFlat().length).toBeGreaterThan(0))
      harness.engine.handleBlur()
      expect(harness.engine.popover()).toBe(kind === "legacy" ? null : "slash")

      harness.engine.openPopover("at")
      await waitFor(() => expect(harness.engine.popover()).toBe("at"))
      await waitFor(() => expect(harness.engine.popoverView.atFlat().length).toBeGreaterThan(0))
    })

    test("Shift+Enter adds a newline and does not submit — behavior 9", async () => {
      harness.type("line")
      await waitFor(() => expect(harness.text()).toBe("line"))
      const event = harness.key({ key: "Enter", shiftKey: true })
      await waitFor(() => expect(harness.text()).toBe("line\n"))
      expect(event.defaultPrevented).toBe(true)
      expect(submitted).toEqual([])
    })

    test("Enter submits", async () => {
      harness.type("send me")
      await waitFor(() => expect(harness.text()).toBe("send me"))
      const event = harness.key({ key: "Enter" })
      expect(submitted).toEqual(["submit"])
      expect(event.defaultPrevented).toBe(true)
    })

    test("ArrowUp on an empty editor restores the last history entry", async () => {
      harness.engine.addToHistory([{ type: "text", content: "previous turn", start: 0, end: 13 }], "normal")
      harness.editor.textContent = ""
      harness.editor.focus()
      setCursorPosition(harness.editor, 0)
      harness.key({ key: "ArrowUp" })
      await waitFor(() => expect(harness.text()).toBe("previous turn"))
    })

    test("a programmatic draft change re-renders the editor DOM, pills included", async () => {
      harness.prompt.set(
        [
          { type: "text", content: "see ", start: 0, end: 4 },
          { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13 },
        ],
        13,
      )
      await waitFor(() => expect(harness.editor.querySelector('[data-type="file"]')).toBeTruthy())
      expect(harness.editor.querySelector('[data-type="file"]')?.getAttribute("data-path")).toBe("src/a.ts")
    })

    test("the draft is the shared source of truth, so a flip cannot lose it", async () => {
      harness.type("survives the flip")
      await waitFor(() => expect(harness.text()).toBe("survives the flip"))
      const parts = harness.prompt.current()
      const scope = mounted.directory
      cleanup()
      document.body.replaceChildren()
      mount(kind === "legacy" ? "controller" : "legacy", scope)
      // Same directory scope, so the SAME prompt-cache entry: the other engine
      // starts from the draft the first one left behind.
      await waitFor(() => expect(harness.text()).toBe("survives the flip"))
      expect(harness.prompt.current()).toEqual(parts)
      // ...and the new engine renders it into its own editor element.
      renderPromptEditor(harness.editor, harness.prompt.current())
      expect(harness.editor.textContent).toBe("survives the flip")
    })
  })
}
