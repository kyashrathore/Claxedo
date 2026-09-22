import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type {
  AgentAssistantMessage,
  AgentFilePart,
  AgentToolPart,
} from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"

// jsdom has no blob URL implementation; supply only that browser I/O boundary.
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:test" })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => {} })
})
afterAll(() => {
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate)
  else Reflect.deleteProperty(URL, "createObjectURL")
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke)
  else Reflect.deleteProperty(URL, "revokeObjectURL")
})

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

function mount(part: AgentToolPart, readToolImage?: (attachment: AgentFilePart, signal: AbortSignal) => Promise<Blob>) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        readToolImage={readToolImage}
        fileUrl={(path) => `http://runtime.test/file/raw?path=${encodeURIComponent(path)}`}
      >
        <Part part={part} message={message} />
      </DataProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

describe("a tool row shows the images its call produced", () => {
  test("a viewed image opens full view by click and keyboard, then closes with Escape", async () => {
    const part = toolPart({ tool: "view_image", attachments: [filePart({ mime: "image/png", url: PNG_URL, filename: "shot.png" })] })
    part.state.input = { path: "/tmp/shot.png", intent: "generic", kind: "image_view" }
    const view = mount(part)
    expect(view.container.textContent).toContain("View image")
    expect(view.container.textContent).not.toContain("kind=image_view")
    expect(view.container.textContent).not.toContain("intent=generic")
    const button = view.container.querySelector<HTMLButtonElement>('[data-slot="tool-image-open"]')!
    expect(button.tagName).toBe("BUTTON")
    fireEvent.click(button)
    await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("src", PNG_URL))
    const user = userEvent.setup()
    await user.keyboard("{Escape}")
    await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull())
    button.focus()
    await user.keyboard("{Enter}")
    await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("src", PNG_URL))
    await user.keyboard("{Escape}")
    await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull())
  })

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

  test("expands an unretained attachment inline to say why no image is shown", () => {
    const view = mount(toolPart({
      tool: "read",
      attachments: [filePart({
        mime: "image/png",
        url: "file:///tmp/ct-3.png",
        filename: "ct-3.png",
        location: { kind: "unretained", bytes: 105_308 },
      })],
    }))

    const toggle = view.container.querySelector<HTMLButtonElement>('button[data-slot="tool-image-unavailable-row"]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    expect(view.container.querySelector('[data-slot="tool-image-unavailable-note"]')).toBeNull()

    fireEvent.click(toggle!)
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(view.container.querySelector('[data-slot="tool-image-unavailable-note"]')?.textContent)
      .toContain("This image (103 KB) is too large to keep in the transcript")

    fireEvent.click(toggle!)
    expect(view.container.querySelector('[data-slot="tool-image-unavailable-note"]')).toBeNull()
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


test("loads a recorded reference separately, opens its blob and releases it without modifying the part", async () => {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tool-image")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const attachment = filePart({ mime: "image/*", url: "", filename: "shot.png", location: { kind: "tool-file", path: "/tmp/shot.png" } })
  const part = toolPart({ tool: "view_image", attachments: [attachment] })
  const before = JSON.stringify(part)
  const read = vi.fn(async (_attachment: AgentFilePart, _signal: AbortSignal) => new Blob(["pixels"], { type: "image/png" }))
  const view = mount(part, read)
  await vi.waitFor(() => expect(view.container.querySelector("img")).toHaveAttribute("src", "blob:tool-image"))
  expect(read).toHaveBeenCalledWith(attachment, expect.any(AbortSignal))
  fireEvent.click(view.container.querySelector('[data-slot="tool-image-open"]')!)
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("src", "blob:tool-image"))
  expect(JSON.stringify(part)).toBe(before)
  await userEvent.setup().keyboard("{Escape}")
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull())
  view.unmount()
  expect(revoke).toHaveBeenCalledWith("blob:tool-image")
  expect(read.mock.calls[0][1].aborted).toBe(true)
  create.mockRestore()
  revoke.mockRestore()
})

test("discards a late image response after unmount without creating a blob or changing the message", async () => {
  const create = vi.spyOn(URL, "createObjectURL")
  let finish!: (blob: Blob) => void
  const part = toolPart({ tool: "view_image", attachments: [filePart({ mime: "image/*", url: "", location: { kind: "tool-file", path: "/tmp/shot.png" } })] })
  const before = JSON.stringify(part)
  const view = mount(part, () => new Promise((resolve) => { finish = resolve }))
  view.unmount()
  finish(new Blob(["pixels"]))
  await Promise.resolve()
  expect(create).not.toHaveBeenCalled()
  expect(JSON.stringify(part)).toBe(before)
  create.mockRestore()
})

test("a failed image request leaves the transcript intact and renders unavailable", async () => {
  const part = toolPart({ tool: "view_image", attachments: [filePart({ mime: "image/*", url: "", filename: "gone.png", location: { kind: "tool-file", path: "/tmp/gone.png" } })] })
  const before = JSON.stringify(part)
  const view = mount(part, async () => { throw new Error("404") })
  await Promise.resolve()
  expect(view.container.querySelector('[data-slot="tool-image-unavailable"]')).toHaveTextContent("gone.png")
  expect(view.container.querySelector("img")).toBeNull()
  expect(JSON.stringify(part)).toBe(before)
})

test("retry fetches only the image and recovers without rewriting the tool result", async () => {
  const part = toolPart({ tool: "view_image", attachments: [filePart({ mime: "image/*", url: "", filename: "recovered.png", location: { kind: "tool-file", path: "/tmp/recovered.png" } })] })
  const before = JSON.stringify(part)
  const read = vi.fn<(attachment: AgentFilePart, signal: AbortSignal) => Promise<Blob>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Blob(["pixels"], { type: "image/png" }))
  const view = mount(part, read)
  const retry = await view.findByRole("button", { name: "Retry" })
  fireEvent.click(retry)
  await vi.waitFor(() => expect(view.container.querySelector('[data-slot="tool-image-thumbnail"]')).toHaveAttribute("src", "blob:test"))
  expect(read).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(part)).toBe(before)
})
