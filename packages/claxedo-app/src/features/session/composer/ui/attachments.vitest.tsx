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
    },
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, undefined, () => true] as const,
  }
})

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

import { PromptProvider, usePrompt } from "@/features/session/providers/prompt"
import { createPromptAttachments } from "./attachments"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)

let prompt: ReturnType<typeof usePrompt>
let attachments: ReturnType<typeof createPromptAttachments>

function Probe() {
  prompt = usePrompt()
  const editor = document.createElement("div")
  attachments = createPromptAttachments({
    editor: () => editor,
    isDialogActive: () => false,
    setDraggingType: () => {},
    focusEditor: () => {},
    addPart: () => false,
  })
  return <div data-testid="probe">{prompt.current().filter((part) => part.type === "image").length}</div>
}

function imagesIn(scope: { dir: string; id?: string; draftId?: string }) {
  return prompt.capture(scope).store[0]().prompt.filter((part) => part.type === "image")
}

function pngFile(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" })
}

afterEach(() => {
  cleanup()
  setSessionId(undefined)
})

describe("prompt attachments", () => {
  test("attaches to the thread the composer was on, not the one it lands in", async () => {
    setSessionId("ses-a")
    render(() => (
      <PromptProvider directory="/repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    const pending = attachments.addAttachment(pngFile("shot.png"))
    setSessionId("ses-b")
    await pending

    await waitFor(() => expect(imagesIn({ dir: "/repo", id: "ses-a" })).toHaveLength(1))
    expect(imagesIn({ dir: "/repo", id: "ses-b" })).toHaveLength(0)
  })
})
