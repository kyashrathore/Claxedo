import { describe, expect, test } from "bun:test"
import { routeSessionHarness } from "./route-session-harness"

describe("route session harness", () => {
  test("recovers non-OpenCode harness refs from runtime config shapes", () => {
    expect(routeSessionHarness({
      config: {
        harness: {
          type: "claude-acp",
        },
      },
    })).toEqual({ id: "claude-acp" })

    expect(routeSessionHarness({
      runner: {
        type: "codex-acp",
        binary: "/opt/bin/codex",
      },
    })).toEqual({ id: "codex-acp", binary: "/opt/bin/codex" })

    expect(routeSessionHarness({
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "process",
          binary: "/opt/bin/claude",
        },
      },
    })).toEqual({ id: "claude-acp", binary: "/opt/bin/claude" })
  })

  test("does not force an explicit harness ref for OpenCode sessions", () => {
    expect(routeSessionHarness({
      config: {
        harness: {
          type: "opencode",
        },
      },
    })).toBeUndefined()
  })

  test("recovers the canonical harness tag from durable central session metadata", () => {
    expect(routeSessionHarness({
      host: "central",
      tags: ["source-channel:telegram", "harness:pi"],
    })).toEqual({ id: "pi" })
  })
})
