import { describe, expect, test } from "bun:test"
import { bootstrapGlobalShellData } from "./global-bootstrap"

describe("global bootstrap shell-data boundary", () => {
  test("forwards harness-scoped global bootstrap requests", async () => {
    const calls: Array<string | undefined> = []

    await bootstrapGlobalShellData({
      source: {
        bootstrap: (harnessType?: string) => {
          calls.push(harnessType)
        },
      },
      harnessType: "codex-acp",
    })

    expect(calls).toEqual(["codex-acp"])
  })
})
