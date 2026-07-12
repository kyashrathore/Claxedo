import { describe, expect, test } from "bun:test"
import { recordPromptSubmission } from "./post-submit"

// Moved out of handoff.test.ts when recordPromptSubmission migrated to its
// own module (rubric Q2).
describe("recordPromptSubmission", () => {
  test("runs onSubmit + saveSessionConfig + refreshDirectory + capture in order", async () => {
    const seen: string[] = []
    let saveResolved = false
    await recordPromptSubmission({
      onSubmit: () => seen.push("submit"),
      saveSessionConfig: async () => {
        seen.push("config-start")
        await new Promise<void>((r) => setTimeout(r, 1))
        seen.push("config-end")
        saveResolved = true
      },
      refreshDirectory: () => seen.push("refresh"),
      capture: () => seen.push("capture"),
    })
    expect(saveResolved).toBe(true)
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

  test("saveSessionConfig rejection bubbles", async () => {
    let caught: unknown
    try {
      await recordPromptSubmission({
        saveSessionConfig: async () => {
          throw new Error("persist failed")
        },
        capture: () => undefined,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("persist failed")
  })
})
