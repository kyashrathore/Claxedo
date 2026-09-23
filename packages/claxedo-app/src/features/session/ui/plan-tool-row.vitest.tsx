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

const PLAN = "# Finish steering\n\n## Context\n\nSteering reaches the running turn."

function toolPart(tool: string, input: Record<string, unknown>, status: "running" | "completed" = "completed"): AgentToolPart {
  return {
    id: `prt-${tool}`,
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    callID: `toolu-${tool}`,
    tool,
    state: status === "completed"
      ? { status, input, output: "", title: tool, metadata: {}, time: { start: 1, end: 3 } }
      : { status, input, title: tool, metadata: {}, time: { start: 1 } },
  } as AgentToolPart
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

describe("plan-mode tool rows", () => {
  test("entering plan mode reads as a sentence, not the raw tool name", async () => {
    const view = mount(toolPart("enterplanmode", { intent: "generic", kind: "dynamic_tool_call" }))
    await vi.waitFor(() => expect(view.container.textContent).toContain("Entered plan mode"))
    expect(view.container.textContent).not.toContain("enterplanmode")
  })

  test("a proposed plan is titled by its heading and opens in the workspace panel", async () => {
    const view = mount(toolPart("exitplanmode", {
      intent: "generic",
      kind: "dynamic_tool_call",
      plan: PLAN,
      planFilePath: "/Users/me/.claude/plans/snappy-puzzling-rainbow.md",
    }))
    await vi.waitFor(() => expect(view.container.textContent).toContain("Planned"))
    const subtitle = view.container.querySelector<HTMLElement>('[data-slot="basic-tool-tool-subtitle"]')
    expect(subtitle?.textContent).toBe("Finish steering")

    const opened: unknown[] = []
    view.container.addEventListener("claxedo:open-plan", (event) => {
      event.preventDefault()
      opened.push((event as CustomEvent).detail)
    })
    fireEvent.click(subtitle!)
    fireEvent.click(view.container.querySelector<HTMLElement>('[aria-label="Open plan"]')!)

    const detail = { sessionId: "ses-1", planId: "toolu-exitplanmode", title: "Finish steering", markdown: PLAN }
    expect(opened).toEqual([detail, detail])
  })

  test("the plan can be opened while it still awaits approval", async () => {
    const view = mount(toolPart("exitplanmode", { plan: PLAN }, "running"))
    const opened: unknown[] = []
    view.container.addEventListener("claxedo:open-plan", (event) => opened.push((event as CustomEvent).detail))
    await vi.waitFor(() => expect(view.container.querySelector('[data-slot="basic-tool-tool-subtitle"]')).toBeTruthy())
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-slot="basic-tool-tool-subtitle"]')!)
    expect(opened).toHaveLength(1)
  })

  test("the row expands to the plan's markdown inline", async () => {
    const view = mount(toolPart("exitplanmode", { plan: PLAN }))
    const trigger = await vi.waitFor(() => {
      const el = view.container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
      expect(el).toBeTruthy()
      return el!
    })
    fireEvent.click(trigger)
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-slot="collapsible-content"]')?.textContent).toContain("Steering reaches"),
    )
  })
})
