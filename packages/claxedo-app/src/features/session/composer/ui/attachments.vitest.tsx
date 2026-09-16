import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { cleanup, render, waitFor } from "@solidjs/testing-library"

vi.mock("@/features/session/app-ports", () => ({
  useServer: () => ({ url: "http://localhost:4096" }),
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
import { createPromptAttachments } from "./attachments"
import type { AttachmentTarget } from "./files"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)

let prompt: ReturnType<typeof usePrompt>
let attachments: ReturnType<typeof createPromptAttachments>

const localClaude: AttachmentTarget = { harness: { kind: "native", harnessId: "claude" }, workspace: true }
const hostedClaude: AttachmentTarget = { harness: { kind: "native", harnessId: "claude" }, workspace: false }

function Probe(props: { target: AttachmentTarget }) {
  prompt = usePrompt()
  const editor = document.createElement("div")
  attachments = createPromptAttachments({
    editor: () => editor,
    isDialogActive: () => false,
    setDraggingType: () => {},
    focusEditor: () => {},
    addPart: () => false,
    target: () => props.target,
  })
  return <div data-testid="probe">{prompt.current().filter((part) => part.type === "image").length}</div>
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
})

describe("prompt attachments", () => {
  test("attaches to the thread the composer was on, not the one it lands in", async () => {
    setSessionId("ses-a")
    mount(localClaude)

    const pending = attachments.addAttachment(pngFile("shot.png"))
    setSessionId("ses-b")
    await pending

    await waitFor(() => expect(attachmentsIn({ dir: "/repo", id: "ses-a" })).toHaveLength(1))
    expect(attachmentsIn({ dir: "/repo", id: "ses-b" })).toHaveLength(0)
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
