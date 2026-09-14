import { describe, expect, test } from "bun:test"
import { subagentChipHandlesClick, subagentChipUnclaimedClick, subagentSpawnDetail } from "./subagent-chip"

describe("subagent chip click semantics", () => {
  test("a modified click on an anchor chip belongs to the browser", () => {
    expect(subagentChipHandlesClick({ modified: true, hasHref: true })).toBe(false)
    expect(subagentChipHandlesClick({ modified: false, hasHref: true })).toBe(true)
  })

  test("a chip with no href handles every click, modified or not", () => {
    expect(subagentChipHandlesClick({ modified: true, hasHref: false })).toBe(true)
    expect(subagentChipHandlesClick({ modified: false, hasHref: false })).toBe(true)
  })

  test("an unopenable transcript goes nowhere, with or without a router", () => {
    expect(subagentChipUnclaimedClick({ openable: false, canNavigate: true, hasHref: true })).toBe("none")
    expect(subagentChipUnclaimedClick({ openable: false, canNavigate: false, hasHref: false })).toBe("none")
  })

  test("a router takes the unclaimed open before the anchor's own navigation", () => {
    expect(subagentChipUnclaimedClick({ openable: true, canNavigate: true, hasHref: true })).toBe("navigate")
  })

  test("without a router the anchor's href is what is left", () => {
    expect(subagentChipUnclaimedClick({ openable: true, canNavigate: false, hasHref: true })).toBe("href")
    expect(subagentChipUnclaimedClick({ openable: true, canNavigate: false, hasHref: false })).toBe("none")
  })
})

describe("subagentSpawnDetail", () => {
  test("names the configuration slot and model a create_subagent asked for, and leaves the effort out", () => {
    expect(subagentSpawnDetail({ configuration: "review", prompt: "check it", model: { providerID: "anthropic", id: "claude-opus-5" }, effort: "high" }))
      .toBe("review · claude-opus-5")
  })

  test("falls back to the harness when no configuration slot was named", () => {
    expect(subagentSpawnDetail({ harness: "codex", prompt: "go" })).toBe("codex")
  })

  test("reads codex's nested arguments and claude's string model", () => {
    expect(subagentSpawnDetail({ server: "claxedo", tool: "create_subagent", arguments: { harness: "claude", model: { providerID: "anthropic", id: "claude-sonnet-5" } } }))
      .toBe("claude · claude-sonnet-5")
    expect(subagentSpawnDetail({ subagent_type: "Explore", model: "opus", prompt: "find it" })).toBe("opus")
  })

  test("says nothing when the spawn named nothing", () => {
    expect(subagentSpawnDetail({ prompt: "go" })).toBeUndefined()
    expect(subagentSpawnDetail(undefined)).toBeUndefined()
  })
})
