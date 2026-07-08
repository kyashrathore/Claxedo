import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "../../shared/query/query-client"
import { pendingRecovery, resolveRecovery, trackRecovery } from "./pane-terminal-recovery"

afterEach(() => {
  queryClient.clear()
})

describe("pane terminal recovery", () => {
  test("dedupes concurrent clone recovery through Query and remembers the alias", async () => {
    const alias = new Map<string, { id: string; at: number }>()
    let calls = 0
    let release: (id: string) => void
    const run = () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const first = trackRecovery(alias, "pty-old", run)
    const second = trackRecovery(alias, "pty-old", run)

    expect(second).toBe(first)
    expect(pendingRecovery("pty-old")).toBe(first)
    expect(calls).toBe(1)

    release!("pty-new")
    await expect(first).resolves.toBe("pty-new")

    expect(resolveRecovery(alias, "pty-old")).toBe("pty-new")
    expect(pendingRecovery("pty-old")).toBeUndefined()
  })

  test("reuses an existing alias without opening a new recovery request", async () => {
    const alias = new Map<string, { id: string; at: number }>([
      ["pty-old", { id: "pty-new", at: Date.now() }],
    ])

    await expect(trackRecovery(alias, "pty-old", () => Promise.resolve("unused"))).resolves.toBe("pty-new")
    expect(pendingRecovery("pty-old")).toBeUndefined()
  })

  test("terminal renderers do not own private recovery inflight maps", async () => {
    const content = await Bun.file(new URL("../content-renderers/terminal-content.tsx", import.meta.url)).text()
    const recovery = await Bun.file(new URL("./pane-terminal-recovery.ts", import.meta.url)).text()

    expect(content).not.toContain("recoveryInflight")
    expect(recovery).not.toContain("inflight: Map")
    expect(recovery).toContain('["shell", "terminal-recovery", id]')
  })
})
