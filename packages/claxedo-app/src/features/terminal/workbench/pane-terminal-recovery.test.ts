import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
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
    const alias = new Map<string, { id: string; at: number }>([["pty-old", { id: "pty-new", at: Date.now() }]])

    await expect(trackRecovery(alias, "pty-old", () => Promise.resolve("unused"))).resolves.toBe("pty-new")
    expect(pendingRecovery("pty-old")).toBeUndefined()
  })

  test("shares one in-flight recovery promise across separate consumers of the same stale id", async () => {
    // Two independent consumers (distinct alias maps, as two renderer
    // instances would be) request recovery of the same terminal id. The
    // in-flight promise must live in the shared Query cache — not a private
    // per-consumer map — so the second consumer joins the first request
    // instead of opening a duplicate clone.
    const aliasA = new Map<string, { id: string; at: number }>()
    const aliasB = new Map<string, { id: string; at: number }>()
    let calls = 0
    let release: (id: string) => void
    const run = () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const first = trackRecovery(aliasA, "pty-stale", run)
    const second = trackRecovery(aliasB, "pty-stale", run)

    expect(second).toBe(first)
    expect(calls).toBe(1)

    release!("pty-fresh")
    await expect(first).resolves.toBe("pty-fresh")
    await expect(second).resolves.toBe("pty-fresh")
    expect(pendingRecovery("pty-stale")).toBeUndefined()
  })
})
