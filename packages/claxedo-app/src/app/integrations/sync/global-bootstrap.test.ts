import { describe, expect, test } from "bun:test"
import { bootstrapGlobalShellData } from "./global-bootstrap"

describe("global bootstrap shell-data boundary", () => {
  test("forwards harness-scoped global bootstrap requests", async () => {
    const calls: Array<{ harnessType?: string; force?: boolean }> = []

    await bootstrapGlobalShellData({
      source: {
        bootstrap: (harnessType?: string, opts?: { force?: boolean }) => {
          calls.push({ harnessType, force: opts?.force })
        },
      },
      harnessType: "codex-acp",
      force: true,
    })

    expect(calls).toEqual([{ harnessType: "codex-acp", force: true }])
  })
})
