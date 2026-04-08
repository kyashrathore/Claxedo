import { describe, expect, test } from "bun:test"
import { rememberRecovery, resolveRecovery, trackRecovery } from "./pane-terminal-recovery"

describe("pane terminal recovery", () => {
  test("trackRecovery shares an in-flight clone promise", async () => {
    const inflight = new Map<string, Promise<string | undefined>>()
    const alias = new Map<string, { id: string; at: number }>()
    let count = 0
    let done!: (value: string | undefined) => void

    const run = () =>
      new Promise<string | undefined>((resolve) => {
        count += 1
        done = resolve
      })

    const a = trackRecovery(inflight, alias, "pty-old", run)
    const b = trackRecovery(inflight, alias, "pty-old", run)

    expect(a).toBe(b)
    expect(count).toBe(1)

    done("pty-new")

    expect(await a).toBe("pty-new")
    expect(resolveRecovery(alias, "pty-old")).toBe("pty-new")
  })

  test("resolveRecovery follows remembered replacements", () => {
    const alias = new Map<string, { id: string; at: number }>()

    rememberRecovery(alias, "pty-a", "pty-b")
    rememberRecovery(alias, "pty-b", "pty-c")

    expect(resolveRecovery(alias, "pty-a")).toBe("pty-c")
    expect(resolveRecovery(alias, "pty-b")).toBe("pty-c")
    expect(resolveRecovery(alias, "pty-c")).toBe("pty-c")
  })
})
