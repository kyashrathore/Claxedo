import { describe, expect, test } from "bun:test"
import { routeSessionHarness } from "./route-session-harness"

describe("route session harness", () => {
  test("recovers non-OpenCode harness refs from runtime config shapes", () => {
    expect(routeSessionHarness({
      config: {
        harness: {
          type: "acp:claude",
        },
      },
    })).toEqual({ id: "acp:claude" })

    expect(routeSessionHarness({
      runner: {
        type: "acp:codex",
        binary: "/opt/bin/codex",
      },
    })).toEqual({ id: "acp:codex", binary: "/opt/bin/codex" })

    expect(routeSessionHarness({
      config: {
        harness: {
          type: "claude-sdk",
        },
      },
    })).toEqual({ id: "claude-sdk" })

    expect(routeSessionHarness({
      runner: {
        type: "codex-app-server",
        binary: "/opt/bin/codex",
      },
    })).toEqual({ id: "codex-app-server", binary: "/opt/bin/codex" })

    // An operator-configured ACP connection: `{id, access: "acp"}` recovers to
    // the open `acp:<slug>` key, the same translation `pickHarness` performs.
    expect(routeSessionHarness({
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "process",
          binary: "/opt/bin/claude",
        },
      },
    })).toEqual({ id: "acp:claude", binary: "/opt/bin/claude" })

    expect(routeSessionHarness({
      harness: {
        id: "claude",
        access: "native",
      },
    })).toEqual({ id: "claude-sdk" })
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
