import { describe, expect, test } from "bun:test"
import { aliasTerminalSessionPreview, loadTerminalSessionPreview } from "./terminal-session-preview"

describe("terminal session preview aliases", () => {
  test("loadTerminalSessionPreview follows replacement terminal ids", async () => {
    aliasTerminalSessionPreview("pty-old", "pty-new")

    let seen = ""
    const out = await loadTerminalSessionPreview(
      "http://localhost:3001",
      "pty-old",
      (input) => {
        seen = String(input)
        return Promise.resolve(
          new Response(JSON.stringify({
            success: true,
            terminalId: "pty-new",
            session: {
              terminalId: "pty-new",
              provider: "opencode",
              sessionId: "sess-1",
              updatedAt: Date.now(),
            },
          })),
        )
      },
    )

    expect(seen).toContain("terminalId=pty-new")
    expect(out?.terminalId).toBe("pty-new")
    expect(out?.sessionId).toBe("sess-1")
  })

  test("loadTerminalSessionPreview treats empty session payload as no preview", async () => {
    const out = await loadTerminalSessionPreview(
      "http://localhost:3001",
      "pty-empty",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({
            success: true,
            source: "none",
            terminalId: "pty-empty",
            session: null,
          })),
        ),
    )

    expect(out).toBeNull()
  })
})
