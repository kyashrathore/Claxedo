import { describe, expect, test, vi } from "vitest"
import { agentUsageOrNone } from "./machine-agent-usage"

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
