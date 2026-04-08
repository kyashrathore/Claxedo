import { describe, expect, test } from "bun:test"
import { aliasTerminalLogSummary, loadTerminalLogSummary } from "./terminal-log-summary"

describe("terminal log summary aliases", () => {
  test("loadTerminalLogSummary follows replacement terminal ids", async () => {
    aliasTerminalLogSummary("pty-old", "pty-new")

    let seen = ""
    const out = await loadTerminalLogSummary(
      "http://localhost:3001",
      "pty-old",
      "/workspace",
      (input) => {
        seen = String(input)
        return Promise.resolve(new Response("first line\nsecond line with signal\n"))
      },
    )

    expect(seen).toContain("pty_id=pty-new")
    expect(out?.title).toBeDefined()
  })
})
