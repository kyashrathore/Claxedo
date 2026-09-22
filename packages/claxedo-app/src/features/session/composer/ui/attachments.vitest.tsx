import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { cleanup, render, waitFor } from "@solidjs/testing-library"

vi.mock("@/features/session/app-ports", async () => ({
  useServer: () => ({ url: "http://localhost:4096" }),
  usePaneCtx: (await import("@/app/workbench/context/pane-ctx")).usePaneCtx,
}))

vi.mock("@/platform/persistence/persist", async () => {
  const { createStore } = await import("solid-js/store")
  return {
    Persist: {
      scoped: (...input: unknown[]) => JSON.stringify(input),
      serverScoped: (...input: unknown[]) => JSON.stringify(input),
      global: (...input: unknown[]) => JSON.stringify(input),
    },
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, undefined, () => true] as const,
    removePersisted: () => undefined,
  }
})

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string, params?: Record<string, string>) => [key, params?.harness, params?.mime].filter(Boolean).join(" ") }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

import { showToast } from "@opencode-ai/ui/toast"
import { PromptProvider, usePrompt } from "@/features/session/providers/prompt"
import { PaneCtxProvider } from "@/app/workbench/context/pane-ctx"
import type { PaneCtx } from "@/app/workbench/workbench/workbench"
import { createPromptAttachments } from "./attachments"
import type { AttachmentTarget } from "./files"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)

let prompt: ReturnType<typeof usePrompt>
let attachments: ReturnType<typeof createPromptAttachments>
let readClipboardImage: (() => Promise<File | null>) | undefined

const localClaude: AttachmentTarget = { harness: { kind: "native", harnessId: "claude" }, workspace: true }
const hostedClaude: AttachmentTarget = { harness: { kind: "native", harnessId: "claude" }, workspace: false }

function Probe(props: { target: AttachmentTarget; active?: boolean }) {
  prompt = usePrompt()
  const editor = document.createElement("div")
  let root: HTMLDivElement | undefined
  attachments = createPromptAttachments({
    editor: () => editor,
    root: () => root,
    isDialogActive: () => false,
    active: () => props.active !== false,
    setDraggingType: () => {},
    focusEditor: () => {},
    addPart: () => false,
    target: () => props.target,
    readClipboardImage,
  })
  return <div ref={root} data-testid="probe">{prompt.current().filter((part) => part.type === "image").length}</div>
}

/** A workbench slot as the workbench hands it down: the surface binds pointer input to `element`. */
function slot(paneId: string, element: () => HTMLDivElement | undefined): PaneCtx {
  return {
    paneId,
    isVisible: () => true,
    isFocused: () => true,
    element,
    onKeyDown: () => {},
    requestClose: () => {},
    requestFocus: () => {},
    presentation: () => "docked",
  }
}

/** Two composers in two workbench slots, as a split view mounts them. */
function mountSplit(sessions: [string, string]) {
  let slotA: HTMLDivElement | undefined
  let slotB: HTMLDivElement | undefined
  return render(() => (
    <>
      <div ref={slotA} data-pane-id="pane-a">
        <PaneCtxProvider ctx={slot("pane-a", () => slotA)}>
          <PromptProvider directory="/repo" sessionId={sessions[0]}><Probe target={localClaude} /></PromptProvider>
        </PaneCtxProvider>
      </div>
      <div ref={slotB} data-pane-id="pane-b">
        <PaneCtxProvider ctx={slot("pane-b", () => slotB)}>
          <PromptProvider directory="/repo" sessionId={sessions[1]}><Probe target={localClaude} /></PromptProvider>
        </PaneCtxProvider>
      </div>
      <div data-testid="outside" />
    </>
  ))
}

function drop(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], getData: () => "" },
  })
  target.dispatchEvent(event)
}


function attachmentsIn(scope: { dir: string; id?: string; draftId?: string }) {
  return prompt.capture(scope).store[0]().prompt.filter((part) => part.type === "image")
}

function pngFile(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" })
}

function videoFile(name: string) {
  return new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: "video/mp4" })
}

function mount(target: AttachmentTarget) {
  render(() => (
    <PromptProvider directory="/repo" sessionId={sessionId}>
      <Probe target={target} />
    </PromptProvider>
  ))
}

function paste(files: File[]) {
  return attachments.handlePaste({
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => "",
    },
    preventDefault() {},
    stopPropagation() {},
  })
}

afterEach(() => {
  cleanup()
  setSessionId(undefined)
  vi.mocked(showToast).mockClear()
  readClipboardImage = undefined
})

describe("prompt attachments", () => {
  // The listener is bound to the composer's own surface, so a retained pane
  // that is not the active one still has a zone a file can land on.
  test("a drop on an inactive retained composer's own surface is refused", async () => {
    const view = render(() => (
      <PromptProvider directory="/repo" sessionId={() => "inactive"}>
        <Probe target={localClaude} active={false} />
      </PromptProvider>
    ))
    const inactivePrompt = prompt
    const event = new Event("drop", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "dataTransfer", { value: { files: [pngFile("dropped.png")], getData: () => "" } })
    view.getByTestId("probe").dispatchEvent(event)
    await Promise.resolve()
    expect(inactivePrompt.current().filter(part => part.type === "image")).toHaveLength(0)
  })

  test("a native paste finishing after submit reset cannot resurrect the cleared draft", async () => {
    let resolve!: (file: File) => void
    readClipboardImage = () => new Promise<File>(done => { resolve = done })
    setSessionId("submitted-paste")
    mount(localClaude)
    const pending = paste([])
    prompt.reset()
    resolve(pngFile("too-late.png"))
    await pending
    expect(prompt.current().filter(part => part.type === "image")).toHaveLength(0)
    expect(showToast).not.toHaveBeenCalled()
  })

  test("native clipboard completion stays with the session that received paste", async () => {
    let resolve!: (file: File) => void
    readClipboardImage = () => new Promise<File>((done) => { resolve = done })
    setSessionId("native-paste-origin")
    mount(localClaude)
    const pending = paste([])
    setSessionId("native-paste-next")
    resolve(pngFile("native.png"))
    await pending
    expect(attachmentsIn({ dir: "/repo", id: "native-paste-origin" })).toHaveLength(1)
    expect(attachmentsIn({ dir: "/repo", id: "native-paste-next" })).toHaveLength(0)
  })

  test("all files in one paste belong to the original session", async () => {
    setSessionId("multi-paste-origin")
    mount(localClaude)
    const pending = paste([pngFile("first.png"), pngFile("second.png")])
    setSessionId("multi-paste-next")
    await pending
    expect(attachmentsIn({ dir: "/repo", id: "multi-paste-origin" })).toHaveLength(2)
    expect(attachmentsIn({ dir: "/repo", id: "multi-paste-next" })).toHaveLength(0)
  })

  test("attaches to the thread the composer was on, not the one it lands in", async () => {
    setSessionId("ses-a")
    mount(localClaude)

    const pending = attachments.addAttachment(pngFile("shot.png"))
    setSessionId("ses-b")
    await pending

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-a" })).toHaveLength(1))
    expect(attachmentsIn({ dir: "/repo", id: "ses-b" })).toHaveLength(0)
  })

  test("a drop on one slot attaches only to that slot's composer", async () => {
    const view = mountSplit(["ses-split-a", "ses-split-b"])

    drop(view.container.querySelector('[data-pane-id="pane-b"]')!, [pngFile("shot.png")])

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-split-b" })).toHaveLength(1))
    expect(attachmentsIn({ dir: "/repo", id: "ses-split-a" })).toHaveLength(0)
  })

  test("a drop outside every slot attaches to no composer", async () => {
    const view = mountSplit(["ses-out-a", "ses-out-b"])

    drop(view.getByTestId("outside"), [pngFile("shot.png")])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attachmentsIn({ dir: "/repo", id: "ses-out-a" })).toHaveLength(0)
    expect(attachmentsIn({ dir: "/repo", id: "ses-out-b" })).toHaveLength(0)
  })

  test("outside the workbench the composer's own element is the drop zone", async () => {
    setSessionId("ses-own")
    mount(localClaude)
    const view = document.querySelector('[data-testid="probe"]')!

    drop(view, [pngFile("shot.png")])

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-own" })).toHaveLength(1))
  })

  test("keeps a pasted video on a local session, where the runtime can write it into the workspace", async () => {
    setSessionId("ses-local-video")
    mount(localClaude)

    await paste([videoFile("clip.mp4")])

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-local-video" })).toMatchObject([
      { type: "image", mime: "video/mp4", filename: "clip.mp4" },
    ]))
    expect(showToast).not.toHaveBeenCalled()
  })

  test("refuses a pasted video on a hosted session and names the harness that cannot take it", async () => {
    setSessionId("ses-hosted-video")
    mount(hostedClaude)

    await paste([videoFile("clip.mp4")])

    expect(attachmentsIn({ dir: "/repo", id: "ses-hosted-video" })).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith({
      title: "prompt.toast.attachmentHarnessUnsupported.title Claude Code",
      description: "prompt.toast.attachmentHarnessUnsupported.description Claude Code video/mp4",
    })
  })

  test("keeps a pasted image on a hosted session, which the harness image input carries", async () => {
    setSessionId("ses-hosted-image")
    mount(hostedClaude)

    await paste([pngFile("shot.png")])

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-hosted-image" })).toHaveLength(1))
    expect(showToast).not.toHaveBeenCalled()
  })
})
