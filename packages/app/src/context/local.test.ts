import { describe, expect, test } from "bun:test"
import type { Agent } from "@opencode-ai/sdk/v2/client"
import { sameState, withCurrentAgent } from "./local-agent"

const row = (name: string, opts?: Partial<Agent>) =>
  ({
    name,
    mode: "all",
    permission: [],
    options: {},
    ...opts,
  }) satisfies Agent

describe("withCurrentAgent", () => {
  test("adds the persisted session agent when it is missing from the global list", () => {
    const list = withCurrentAgent(
      [row("default")],
      "bypassPermissions",
      {
        agent: "bypassPermissions",
        model: { providerID: "claude-acp", modelID: "opus" },
        variant: "fast",
      },
    )

    expect(list.map((item) => item.name)).toEqual(["bypassPermissions", "default"])
    expect(list[0]?.model).toEqual({ providerID: "claude-acp", modelID: "opus" })
    expect(list[0]?.variant).toBe("fast")
  })

  test("does not duplicate an agent that already exists in the global list", () => {
    const list = withCurrentAgent(
      [row("default"), row("bypassPermissions")],
      "bypassPermissions",
      {
        agent: "bypassPermissions",
        model: { providerID: "claude-acp", modelID: "opus" },
        variant: null,
      },
    )

    expect(list.map((item) => item.name)).toEqual(["default", "bypassPermissions"])
  })

  test("new sessions should not inherit a stale agent from the last selected session", () => {
    const list = withCurrentAgent(
      [row("build"), row("plan")],
      "Agent",
      {
        agent: "Agent",
      },
    )

    expect(list.map((item) => item.name)).toEqual(["build", "plan"])
  })
})

describe("sameState", () => {
  test("treats identical session config as unchanged", () => {
    expect(
      sameState(
        {
          agent: "full-access",
          model: { providerID: "codex-acp", modelID: "gpt-5.4" },
          variant: null,
        },
        {
          agent: "full-access",
          model: { providerID: "codex-acp", modelID: "gpt-5.4" },
          variant: null,
        },
      ),
    ).toBe(true)
  })

  test("treats different agent as changed", () => {
    expect(
      sameState(
        {
          agent: "default",
          model: { providerID: "codex-acp", modelID: "gpt-5.4" },
          variant: null,
        },
        {
          agent: "full-access",
          model: { providerID: "codex-acp", modelID: "gpt-5.4" },
          variant: null,
        },
      ),
    ).toBe(false)
  })
})
