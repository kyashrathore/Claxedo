import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { render, cleanup, waitFor } from "@solidjs/testing-library"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)

vi.mock("@/context/server", () => ({
  useServer: () => ({ url: "http://localhost:4096" }),
}))

vi.mock("@/utils/persist", async () => {
  const { createStore } = await import("solid-js/store")
  return {
    Persist: {
      scoped: (...input: unknown[]) => JSON.stringify(input),
      serverScoped: (...input: unknown[]) => JSON.stringify(input),
    },
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, () => true] as const,
  }
})

import { PromptProvider, usePrompt } from "@/context/prompt"

function text(value: string) {
  return [{ type: "text" as const, content: value, start: 0, end: value.length }]
}

let latest: ReturnType<typeof usePrompt>

function Probe() {
  latest = usePrompt()
  return <div data-testid="prompt">{latest.current().map((part) => ("content" in part ? part.content : "")).join("")}</div>
}

afterEach(() => {
  cleanup()
  setSessionId(undefined)
})

describe("PromptProvider", () => {
  test("keeps drafts isolated per split session and honors scoped set/reset", async () => {
    setSessionId("ses-a")
    const view = render(() => (
      <PromptProvider directory="/repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    latest.set(text("alpha"), 5)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("alpha"))

    setSessionId("ses-b")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe(""))

    latest.set(text("beta"), 4)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("beta"))

    latest.set(text("gamma"), 5, { dir: "/repo", id: "ses-c" })
    latest.reset({ dir: "/repo", id: "ses-c" })

    setSessionId("ses-a")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("alpha"))

    setSessionId("ses-b")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("beta"))
  })
})
