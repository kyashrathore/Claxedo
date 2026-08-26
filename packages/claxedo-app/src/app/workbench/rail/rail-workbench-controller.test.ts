import { describe, expect, test } from "bun:test"

import type { ContentMeta } from "../state"
import { openTerminalDraftAndSelect } from "./rail-workbench-controller"

describe("openTerminalDraftAndSelect", () => {
  test("selects the committed terminal surface after Solid's staged writes settle", async () => {
    const terminal: ContentMeta = {
      id: "terminal-new",
      type: "terminal",
      scope: "directory",
      directory: "/repo",
      terminalId: "new",
    }
    const calls: string[] = []

    const id = openTerminalDraftAndSelect({
      directory: "/repo",
      open: (directory, terminalId, title) => {
        calls.push(`open:${directory}:${terminalId}:${title}`)
        return terminal.id
      },
      get: (contentId) => (contentId === terminal.id ? terminal : undefined),
      select: (meta) => calls.push(`select:${meta.id}`),
    })

    expect(id).toBe(terminal.id)
    expect(calls).toEqual(["open:/repo:new:New Terminal"])

    await Promise.resolve()
    expect(calls).toEqual(["open:/repo:new:New Terminal", "select:terminal-new"])
  })
})
