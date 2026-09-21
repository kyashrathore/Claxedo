import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AgentAssistantMessage, AgentFilePart, AgentToolPart, AgentToolState } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"
import { handleTranscriptLinkClick } from "../../../../../session-ui/src/components/transcript-link"

// P-68: transcript anchors bind tool/agent output (`part.url`, `input.url`)
// straight into `href`. A refused scheme must render the label inert, and the
// click handler must suppress default navigation — including modified clicks —
// rather than return early while the browser still resolves the anchor.

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

function filePart(url: string, mime = "text/plain"): AgentFilePart {
  return { id: "prt-file", sessionID: "ses-1", messageID: "msg-1", type: "file", mime, url }
}

function toolPart(tool: string, input: Record<string, unknown>): AgentToolPart {
  const state: AgentToolState = {
    status: "completed",
    input,
    output: "done",
    title: tool,
    metadata: {},
    time: { start: 1, end: 2 },
  }
  return { id: "prt-tool", sessionID: "ses-1", messageID: "msg-1", type: "tool", callID: "call-1", tool, state }
}

function webfetchPart(url: unknown): AgentToolPart {
  return toolPart("webfetch", { url })
}

function mount(
  part: AgentFilePart | AgentToolPart,
  hrefs: {
    taskHref?: (taskId: string) => string
    sessionHref?: (sessionId: string) => string
    claxedoToolHref?: (tool: string, input: Record<string, unknown>, output?: string) => string | undefined
  } = {},
) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        onSessionHref={hrefs.sessionHref}
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

describe("file part link boundary", () => {
  test("a javascript: file url renders an inert label, not an anchor", () => {
    const view = mount(filePart("javascript:alert(1)"))
    expect(view.container.querySelector('[data-component="file-part"]')).not.toBeNull()
    expect(view.container.querySelector("a[data-slot='file-part-link']")).toBeNull()
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull()
    expect(view.container.textContent).toContain("javascript:alert(1)")
  })

  test("a data: file url is refused the same way", () => {
    const view = mount(filePart("data:text/html,<script>alert(1)</script>"))
    expect(view.container.querySelector("a[data-slot='file-part-link']")).toBeNull()
  })

  test("a file:// url still renders the link", () => {
    const view = mount(filePart("file:///tmp/out.log"))
    const anchor = view.container.querySelector<HTMLAnchorElement>("a[data-slot='file-part-link']")
    expect(anchor?.getAttribute("href")).toBe("file:///tmp/out.log")
    expect(anchor?.getAttribute("target")).toBe("_blank")
  })
})

describe("webfetch tool link boundary", () => {
  test("a javascript: input url renders the subtitle inert", () => {
    const view = mount(webfetchPart("javascript:alert(1)"))
    expect(view.container.querySelector('a[data-slot="basic-tool-tool-subtitle"]')).toBeNull()
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull()
    expect(view.container.querySelector('span[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe(
      "javascript:alert(1)",
    )
  })

  test("an https input url renders the link", () => {
    const view = mount(webfetchPart("https://example.com/docs"))
    const anchor = view.container.querySelector<HTMLAnchorElement>('a[data-slot="basic-tool-tool-subtitle"]')
    expect(anchor?.getAttribute("href")).toBe("https://example.com/docs")
  })
})

describe("claxedo tool link boundary", () => {
  const taskStart = () => toolPart("mcp__claxedo__task_start", { task: "tsk_1", preset: "Alt voice", intent: "mcp" })

  test("a javascript: claxedoToolHref renders the trigger inert", () => {
    const view = mount(taskStart(), { claxedoToolHref: () => "javascript:alert(1)" })
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull()
    expect(view.container.querySelector("a[data-link-kind='claxedo-tool']")).toBeNull()
  })

  test("a real route claxedoToolHref renders the trigger link", () => {
    const view = mount(taskStart(), { claxedoToolHref: () => "/workspace/session?panel=tasks" })
    const anchor = view.container.querySelector<HTMLAnchorElement>("a[data-link-kind='claxedo-tool']")
    expect(anchor?.getAttribute("href")).toBe("/workspace/session?panel=tasks")
  })

  test("a javascript: taskHref renders the subject link inert", () => {
    const view = mount(taskStart(), { taskHref: () => "javascript:alert(1)" })
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull()
    expect(view.container.querySelector("a[data-link-kind='task']")).toBeNull()
  })
})

describe("handleTranscriptLinkClick", () => {
  function click(href: string, init: MouseEventInit = {}) {
    const anchor = document.createElement("a")
    anchor.setAttribute("href", href)
    anchor.addEventListener("click", handleTranscriptLinkClick)
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
    anchor.dispatchEvent(event)
    return event
  }

  test("prevents default navigation for a refused scheme", () => {
    expect(click("javascript:alert(1)").defaultPrevented).toBe(true)
    expect(click("data:text/html,<script>alert(1)</script>").defaultPrevented).toBe(true)
    expect(click("vbscript:msgbox(1)").defaultPrevented).toBe(true)
  })

  test("prevents default on refused schemes even with modifiers held", () => {
    expect(click("javascript:alert(1)", { metaKey: true }).defaultPrevented).toBe(true)
    expect(click("javascript:alert(1)", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
  })

  test("prevents default for a whitespace-smuggled scheme", () => {
    expect(click("java\tscript:alert(1)").defaultPrevented).toBe(true)
  })

  test("a host-declined valid link keeps its default", () => {
    const event = click("https://example.com/docs")
    expect(event.defaultPrevented).toBe(false)
  })

  test("a valid link claimed by the host is consumed", () => {
    const anchor = document.createElement("a")
    anchor.setAttribute("href", "https://example.com/docs")
    anchor.addEventListener("click", handleTranscriptLinkClick)
    anchor.addEventListener("claxedo:open-link", (event) => event.preventDefault())
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  test("non-primary and modified clicks on valid links pass through to the browser", () => {
    const open = vi.fn()
    document.addEventListener("claxedo:open-link", open, { once: true })
    const event = click("https://example.com/docs", { metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
