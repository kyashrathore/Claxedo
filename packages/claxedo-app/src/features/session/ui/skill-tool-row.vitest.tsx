import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import type { AgentAssistantMessage, AgentToolPart } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"

const message: AgentAssistantMessage = {
  id: "msg-1",
  sessionID: "ses-1",
  role: "assistant",
  time: { created: 1 },
  parentID: "msg-0",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  mode: "default",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

// The shape the Claude dynamic-tool lane actually persists: the skill id lives
// on `input.skill`, not `input.name`, and the completion frame carries no output.
function skillPart(output: string | undefined): AgentToolPart {
  return {
    id: "prt-skill",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-skill-1",
    tool: "skill",
    state: {
      status: "completed",
      input: { intent: "generic", kind: "dynamic_tool_call", skill: "code-review" },
      output,
      title: "skill",
      metadata: {},
      time: { start: 1, end: 3 },
    },
  }
}

function mount(part: AgentToolPart) {
  return render(() => (
    <DialogProvider>
      <MarkedProvider nativeParser={async (source: string) => `<p>${source}</p>`}>
        <DataProvider
          data={{ agent: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
          directory="/repo"
          fileUrl={(path) => `http://runtime.test/file/raw?path=${encodeURIComponent(path)}`}
        >
          <Part part={part} message={message} />
        </DataProvider>
      </MarkedProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

describe("a settled skill row names and opens what the skill did", () => {
  // `input.name` is the OpenCode shape; the Claude dynamic-tool call lands the
  // id on `input.skill`, so the title must not fall back to the bare tool name.
  test("the title is the skill's id, not the bare tool name", async () => {
    const view = mount(skillPart("Launching skill: code-review"))
    await vi.waitFor(() => expect(view.container.textContent).toContain("code-review"))
  })

  test("a completed skill carrying its output expands on click", async () => {
    const view = mount(skillPart("Launching skill: code-review"))

    const trigger = view.container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
    expect(trigger).toBeTruthy()
    // The chevron only mounts when the row has something to open.
    expect(view.container.querySelector('[data-slot="collapsible-arrow"]')).toBeTruthy()

    fireEvent.click(trigger!)
    await vi.waitFor(() => {
      expect(view.container.querySelector('[data-slot="collapsible-content"]')?.textContent).toContain(
        "Launching skill: code-review",
      )
    })
  })

  // The workspace stream settles a skill whose completion frame carried no
  // output with `output: ""` — falsy — so the row's only child unmounts, hasChildren
  // drops the arrow, and the trigger still swallows the click onto nothing.
  test("a completed skill with empty output still expands to its call", async () => {
    const view = mount(skillPart(""))

    const trigger = view.container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
    expect(trigger).toBeTruthy()
    expect(view.container.querySelector('[data-slot="collapsible-arrow"]')).toBeTruthy()

    fireEvent.click(trigger!)
    await vi.waitFor(() => {
      const content = view.container.querySelector('[data-slot="collapsible-content"]')
      expect(content).toBeTruthy()
      expect(content?.textContent).toContain("code-review")
    })
  })
})
