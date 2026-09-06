import { describe, expect, test } from "bun:test"
import { recordPromptSubmission } from "./post-submit"

// Moved out of handoff.test.ts when recordPromptSubmission migrated to its
// own module (rubric Q2).
describe("recordPromptSubmission", () => {
  test("runs onSubmit + saveSessionConfig + refreshDirectory + capture in order", async () => {
    const seen: string[] = []
    let release!: () => void
    const saved = new Promise<void>((resolve) => { release = resolve })
    const pending = recordPromptSubmission({
      onSubmit: () => seen.push("submit"),
      saveSessionConfig: async () => {
        seen.push("config-start")
        await saved
        seen.push("config-end")
      },
      refreshDirectory: () => seen.push("refresh"),
      capture: () => seen.push("capture"),
    })
    expect(seen).toEqual(["submit", "config-start"])
    release()
    await pending
    expect(seen).toEqual(["submit", "config-start", "config-end", "refresh", "capture"])
  })

  test("optional onSubmit and refreshDirectory are skipped when absent", async () => {
    let captures = 0
    await recordPromptSubmission({
      saveSessionConfig: async () => undefined,
      capture: () => {
        captures++
      },
    })
    expect(captures).toBe(1)
  })

  test("save rejection prevents refresh and capture", async () => {
    const afterSave: string[] = []
    await expect(recordPromptSubmission({
      saveSessionConfig: async () => { throw new Error("persist failed") },
      refreshDirectory: () => { afterSave.push("refresh") },
      capture: () => { afterSave.push("capture") },
    })).rejects.toThrow("persist failed")
    expect(afterSave).toEqual([])
  })
})
