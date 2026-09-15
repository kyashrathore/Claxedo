import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, expect, test, vi } from "vitest"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AgentAssistantMessage, AgentTextPart } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"

afterEach(cleanup)

test("text rendering uses the part's end even while its assistant message remains open", async () => {
  const message = { id: "a1", sessionID: "s1", role: "assistant", parentID: "u1", time: { created: 1 } } as AgentAssistantMessage
  const [part, setPart] = createSignal<AgentTextPart>({
    id: "p1", messageID: "a1", sessionID: "s1", type: "text", text: "**unfinished", time: { start: 1 },
  })
  const view = render(() => (
    <DialogProvider>
      <MarkedProvider>
        <DataProvider directory="/repo" onSessionHref={(id) => `/s/${id}`} onNavigateToSession={() => {}}
          data={{ agent: [], session: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}>
          <Part part={part()} message={message} />
        </DataProvider>
      </MarkedProvider>
    </DialogProvider>
  ))
  await vi.waitFor(() => expect(view.container.querySelector("strong")?.textContent).toBe("unfinished"))
  // The provider explicitly ends this part with literal unmatched syntax.
  // It must stop being healed as live text without waiting for message end.
  setPart((value) => ({ ...value, time: { start: 1, end: 2 } }))
  await vi.waitFor(() => expect(view.container.querySelector("strong")).toBeNull())
  expect(view.container.textContent).toContain("**unfinished")
  expect(message.time.completed).toBeUndefined()
})
