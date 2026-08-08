import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon, setIconLibrary } from "@opencode-ai/ui/icon"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("lazy icon sprites", () => {
  test("materializes a new symbol when a reused component receives a new name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<symbol id="Typescript"><path d="M0 0"/></symbol>',
      '<symbol id="Python"><path d="M0 0"/></symbol>',
      '<symbol id="codex-20-022"><path d="M0 0"/></symbol>',
      '<symbol id="codex-20-153"><path d="M0 0"/></symbol>',
      "</svg>",
    ].join(""))))
    setIconLibrary("codex")
    const [path, setPath] = createSignal("src/main.ts")
    const [icon, setIcon] = createSignal<"code" | "comment">("code")
    render(() => (
      <>
        <FileIcon node={{ path: path(), type: "file" }} />
        <Icon name={icon()} />
      </>
    ))

    await waitFor(() => {
      expect(document.getElementById("file-icon-sprite-Typescript")).toBeTruthy()
      expect(document.getElementById("codex-icon-sprite-codex-20-022")).toBeTruthy()
    })
    setPath("src/main.py")
    setIcon("comment")

    await waitFor(() => {
      expect(document.getElementById("file-icon-sprite-Python")).toBeTruthy()
      expect(document.getElementById("codex-icon-sprite-codex-20-153")).toBeTruthy()
    })
  })
})
