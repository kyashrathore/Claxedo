import { describe, expect, test } from "bun:test"
import { Process } from "./process"

describe("process schemas", () => {
  test("accepts exactly one diagnostic termination target, including groups", () => {
    expect(Process.DiagnosticTerminateInput.safeParse({ group_key: "leak:5400" }).success).toBe(true)

    const result = Process.DiagnosticTerminateInput.safeParse({
      group_key: "leak:5400",
      process_id: "proc_1",
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toBe("Provide exactly one of pid, pty_id, process_id, group_key")
  })
})
