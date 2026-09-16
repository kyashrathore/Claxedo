import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type {
  AgentAssistantMessage,
  AgentFilePart,
  AgentToolPart,
} from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"

const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

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

function filePart(overrides: Partial<AgentFilePart> & { mime: string; url: string }): AgentFilePart {
  return { id: "prt-file", sessionID: "ses-1", messageID: "msg-1", type: "file", ...overrides }
}

function toolPart(input: { tool: string; attachments: AgentFilePart[] }): AgentToolPart {
  return {
    id: "prt-tool",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: input.tool,
    state: {
      status: "completed",
      input: { query: "a screenshot" },
      output: "captured",
      title: "capture",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: input.attachments,
    },
  }
}

function mount(part: AgentToolPart) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        fileUrl={(path) => `http://runtime.test/file/raw?path=${encodeURIComponent(path)}`}
      >
        <Part part={part} message={message} />
      </DataProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

describe("a tool row shows the images its call produced", () => {
  test("renders an inline attachment as a thumbnail for a tool with no renderer of its own", () => {
    const view = mount(toolPart({
      tool: "mcp__playwright__screenshot",
      attachments: [filePart({ mime: "image/png", url: PNG_URL, filename: "shot.png" })],
    }))

    const image = view.container.querySelector<HTMLImageElement>('[data-slot="tool-image-thumbnail"]')
    expect(image?.getAttribute("src")).toBe(PNG_URL)
    expect(image?.getAttribute("alt")).toBe("shot.png")
    expect(view.container.querySelector('[data-slot="tool-image-unavailable"]')).toBeNull()
  })

  test("resolves a workspace-file attachment through the host's file url", () => {
    const view = mount(toolPart({
      tool: "read",
      attachments: [filePart({
        mime: "image/webp",
        url: "docs/shot.webp",
        filename: "shot.webp",
        location: { kind: "workspace-file", path: "docs/shot.webp" },
      })],
    }))

    const image = view.container.querySelector<HTMLImageElement>('[data-slot="tool-image-thumbnail"]')
    expect(image?.getAttribute("src")).toBe("http://runtime.test/file/raw?path=docs%2Fshot.webp")
  })

  test("reports an unretained attachment's size instead of rendering a broken image", () => {
    const view = mount(toolPart({
      tool: "bash",
      attachments: [filePart({
        mime: "image/png",
        url: "file:///tmp/huge.png",
        filename: "huge.png",
        location: { kind: "unretained", bytes: 98_304 },
      })],
    }))

    const chip = view.container.querySelector('[data-slot="tool-image-unavailable"]')
    expect(chip?.textContent).toContain("huge.png")
    expect(chip?.textContent).toContain("96 KB")
    expect(chip?.querySelector("use")?.getAttribute("href")).toContain("-photo-")
    expect(view.container.querySelector('[data-slot="tool-image-thumbnail"]')).toBeNull()
  })

  test("shows every image of a multi-image result", () => {
    const second = `${PNG_URL}AA`
    const view = mount(toolPart({
      tool: "mcp__playwright__screenshot",
      attachments: [
        filePart({ id: "prt-file-1", mime: "image/png", url: PNG_URL }),
        filePart({ id: "prt-file-2", mime: "image/png", url: second }),
      ],
    }))

    const sources = [...view.container.querySelectorAll('[data-slot="tool-image-thumbnail"]')]
      .map((node) => node.getAttribute("src"))
    expect(sources).toEqual([PNG_URL, second])
  })

  test("leaves a tool that produced no image with no strip at all", () => {
    const view = mount(toolPart({ tool: "bash", attachments: [] }))

    expect(view.container.querySelector('[data-component="tool-image"]')).toBeNull()
  })
})
