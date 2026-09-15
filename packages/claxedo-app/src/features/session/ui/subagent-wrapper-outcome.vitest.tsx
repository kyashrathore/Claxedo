import { cleanup, render } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AgentAssistantMessage, AgentToolPart } from "@claxedo/agent-runtime-contract"
import { DataProvider, type SubagentView } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"
import { subagentHostCallIds } from "../subagents/subagent-parts"

const message: AgentAssistantMessage = {
  id: "reply", sessionID: "parent", role: "assistant", parentID: "prompt", time: { created: 1 },
  modelID: "model", providerID: "codex", mode: "default", agent: "build", path: { cwd: "/repo", root: "/repo" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const child: SubagentView = {
  parentSessionId: "parent", subagentKey: "child-key", childSessionId: "child", toolCallRole: "spawn", status: "completed",
  label: "reviewer", agentLabel: "Reviewer", description: "Review virtualization", transcriptKind: "live", resolution: "ready", ambient: false,
}
function tool(failed: boolean): AgentToolPart {
  return {
    id: "spawn", messageID: "reply", sessionID: "parent", type: "tool", callID: "spawn-call", tool: "task",
    state: failed
      ? { status: "error", input: { intent: "task" }, error: "Tool execution interrupted", time: { start: 1, end: 2 } }
      : { status: "running", input: { intent: "task" }, time: { start: 1 } },
  }
}
function mount(bound: boolean) {
  const [part, setPart] = createSignal(tool(false))
  const view = render(() => (
    <MemoryRouter><Route path="/" component={() => <DialogProvider>
      <DataProvider
        data={{ session: [], session_status: {}, session_diff: {}, message: {}, part: {} }} directory="/repo"
        resolveSubagents={() => bound ? [child] : []}
      >
        <Part part={part()} message={message} />
      </DataProvider>
    </DialogProvider>} /></MemoryRouter>
  ))
  return { ...view, fail: () => setPart(tool(true)) }
}
afterEach(cleanup)

describe("subagent spawn wrapper outcome", () => {
  test("an admitted child remains one inline chip when its wrapper is interrupted", () => {
    const view = mount(true)
    expect(view.container.querySelectorAll('[data-subagent-key="child-key"]')).toHaveLength(1)
    view.fail()
    expect(view.container.querySelectorAll('[data-subagent-key="child-key"]')).toHaveLength(1)
    expect(view.container.textContent).toContain("Reviewer")
    expect(view.container.textContent).not.toContain("Tool execution interrupted")
    expect(subagentHostCallIds({ reply: [tool(true)] }).has("spawn-call")).toBe(true)
  })
  test("an interrupted spawn without an admitted child still displays its error", () => {
    const view = mount(false)
    view.fail()
    expect(view.container.querySelector('[data-subagent-key]')).toBeNull()
    view.container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
    expect(view.container.textContent).toContain("Tool execution interrupted")
  })
})
