import { describe, expect, test, vi } from "vitest"
import { agentUsageOrNone, createMachineAgentUsageCache } from "./machine-agent-usage"
import type { MachineAgentUsage } from "./machine-agent-usage"

function agent(input: Partial<MachineAgentUsage> = {}): MachineAgentUsage {
  return { agent: "claude", harness: "claude", label: "Claude Code", windows: [], at: 1, ...input }
}

describe("machine agent usage cache", () => {
  test("one probe answers every reader that arrives while it stands", async () => {
    const read = vi.fn(async () => [agent()])
    let clock = 0
    const cache = createMachineAgentUsageCache({ read, now: () => clock, freshForMs: 1_000 })

    expect(await cache({ fresh: false })).toEqual([agent()])
    clock = 999
    expect(await cache({ fresh: false })).toEqual([agent()])
    expect(read).toHaveBeenCalledTimes(1)

    clock = 1_000
    await cache({ fresh: false })
    expect(read).toHaveBeenCalledTimes(2)
  })

  test("a refresh reaches the vendor even inside the window it just read", async () => {
    const read = vi.fn(async (fresh: boolean) => [agent({ label: fresh ? "fresh" : "held" })])
    const cache = createMachineAgentUsageCache({ read, now: () => 0, freshForMs: 60_000 })

    await cache({ fresh: false })
    expect(await cache({ fresh: true })).toEqual([agent({ label: "fresh" })])
    expect(read).toHaveBeenNthCalledWith(2, true)
  })

  test("readers that arrive during a probe take its answer instead of starting a second sweep", async () => {
    let release = (_: MachineAgentUsage[]) => {}
    const read = vi.fn(() => new Promise<MachineAgentUsage[]>((resolve) => {
      release = resolve
    }))
    const cache = createMachineAgentUsageCache({ read, now: () => 0 })

    const first = cache({ fresh: false })
    const second = cache({ fresh: true })
    release([agent()])

    expect(await first).toEqual([agent()])
    expect(await second).toEqual([agent()])
    expect(read).toHaveBeenCalledTimes(1)
  })

  test("a probe that threw is asked again rather than remembered as an empty machine", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("keychain locked"))
      .mockResolvedValueOnce([agent()])
    const cache = createMachineAgentUsageCache({ read, now: () => 0 })

    await expect(cache({ fresh: false })).rejects.toThrow("keychain locked")
    expect(await cache({ fresh: false })).toEqual([agent()])
  })
})

describe("agentUsageOrNone", () => {
  test("a host with no probe reports no agents", async () => {
    expect(await agentUsageOrNone(undefined, { fresh: false })).toEqual([])
  })

  test("a probe that failed costs the caller nothing but the figures", async () => {
    const reader = vi.fn(async () => {
      throw new Error("chatgpt.com unreachable")
    })
    expect(await agentUsageOrNone(reader, { fresh: true })).toEqual([])
    expect(reader).toHaveBeenCalledWith({ fresh: true })
  })
})
