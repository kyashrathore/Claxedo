import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { ToolErrorCardV2 } from "@opencode-ai/session-ui/v2/tool-error-card-v2"
import type { AgentAssistantMessage, AgentToolPart, AgentToolState } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { BasicTool, Part } from "@/ui/session-kit"

// P-79: the shared card components accept href props from their host, so the
// components themselves enforce the scheme policy — a caller that hands a
// `javascript:`/`data:` payload gets an inert label, never an anchor.

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

function toolPart(tool: string, state: AgentToolState): AgentToolPart {
  return { id: "prt-tool", sessionID: "ses-1", messageID: "msg-1", type: "tool", callID: "call-1", tool, state }
}

function mount(
  part: AgentToolPart,
  hrefs: {
    taskHref?: (taskId: string) => string
    claxedoToolHref?: (tool: string, input: Record<string, unknown>, output?: string) => string | undefined
  } = {},
) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        onSessionHref={(id) => `/s/${id}`}
        onTaskHref={hrefs.taskHref}
        onNavigateToSession={() => {}}
        onClaxedoToolHref={hrefs.claxedoToolHref}
      >
        <Part part={part} message={message} />
      </DataProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

describe("ToolErrorCard link boundary", () => {
  const refusedTaskStart = () =>
    toolPart("mcp__claxedo__task_start", {
      status: "error",
      input: { task: "tsk_1", preset: "Alt voice", intent: "mcp" },
      error: "No preset is named Alt voice.",
      time: { start: 1, end: 2 },
    })
  const failedProcess = () =>
    toolPart("process", {
      status: "error",
      input: { server: "claxedo-mcp", tool: "process" },
      error: "Unavailable",
      time: { start: 1, end: 2 },
    })

  test("a task href callback returning javascript: renders the subtitle inert", () => {
    const view = mount(refusedTaskStart(), { taskHref: () => "javascript:alert(1)" })
    const card = view.container.querySelector('[data-kind="tool-error-card"]')
    expect(card).not.toBeNull()
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
    const subtitle = card?.querySelector('[data-slot="basic-tool-tool-subtitle"]')
    expect(subtitle?.tagName).toBe("SPAN")
  })

  test("a claxedo-tool href callback returning javascript: renders the subtitle inert", () => {
    const view = mount(failedProcess(), { claxedoToolHref: () => "javascript:alert(1)" })
    expect(view.container.querySelector('[data-kind="tool-error-card"]')).not.toBeNull()
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(view.container.querySelector('a[data-slot="basic-tool-tool-subtitle"]')).toBeNull()
  })

  test("a data: href is refused the same way", () => {
    const view = mount(failedProcess(), { claxedoToolHref: () => "data:text/html,<script>alert(1)</script>" })
    expect(view.container.querySelector('a[data-slot="basic-tool-tool-subtitle"]')).toBeNull()
  })

  test("a real route still renders as the subtitle link", () => {
    const view = mount(failedProcess(), { claxedoToolHref: () => "/workspace/session?panel=processes" })
    const anchor = view.container.querySelector<HTMLAnchorElement>('a[data-slot="basic-tool-tool-subtitle"]')
    expect(anchor?.getAttribute("href")).toBe("/workspace/session?panel=processes")
  })
})

describe("BasicTool link boundary", () => {
  test("a route triggerHref renders the trigger as an anchor", () => {
    const view = render(() => <BasicTool icon="wrench" trigger="Reading" triggerHref="/s/ses_1" />)
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/s/ses_1")
  })

  test("a javascript: triggerHref renders no anchor at all", () => {
    const view = render(() => <BasicTool icon="wrench" trigger="Reading" triggerHref="javascript:alert(1)" />)
    expect(view.container.querySelector("a")).toBeNull()
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull()
  })

  test("triggerAsLink keeps the anchor element but drops a hostile href", () => {
    const view = render(() => (
      <BasicTool icon="wrench" trigger="Reading" triggerAsLink clickable triggerHref="javascript:alert(1)" />
    ))
    const anchor = view.container.querySelector("a")
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute("href")).toBeNull()
    expect(anchor?.getAttribute("role")).toBe("button")
  })
})

describe("ToolErrorCardV2 link boundary", () => {
  test("an external href renders the subtitle link", () => {
    const view = render(() => <ToolErrorCardV2 title="Fetch" subtitle="example.com" subtitleHref="https://example.com" />)
    const anchor = view.container.querySelector<HTMLAnchorElement>('a[data-slot="tool-error-card-subtitle"]')
    expect(anchor?.getAttribute("href")).toBe("https://example.com")
  })

  test("a javascript: subtitleHref falls back to a plain subtitle", () => {
    const view = render(() => <ToolErrorCardV2 title="Fetch" subtitle="alert(1)" subtitleHref="javascript:alert(1)" />)
    expect(view.container.querySelector("a")).toBeNull()
    const subtitle = view.container.querySelector('[data-slot="tool-error-card-subtitle"]')
    expect(subtitle?.tagName).toBe("SPAN")
    expect(subtitle?.textContent).toBe("alert(1)")
  })
})
