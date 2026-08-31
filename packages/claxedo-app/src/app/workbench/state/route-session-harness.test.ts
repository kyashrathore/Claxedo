import { describe, expect, test } from "bun:test"
import { routeSessionHarness } from "./route-session-harness"

describe("route session harness", () => {
  test("recovers harness refs from the canonical selection and runtime identity shapes", () => {
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
        access: "native",
      },
    })).toEqual({ id: "acp:claude", binary: "/opt/bin/claude" })

    expect(routeSessionHarness({
      harness: {
        id: "claude",
        access: "native",
      },
    })).toEqual({ id: "claude-sdk" })
  })

  test("does not revive removed legacy harness config shapes", () => {
    expect(routeSessionHarness({
      config: {
        harness: {
          type: "opencode",
        },
      },
    })).toBeUndefined()
  })

  test("does not infer harness identity from unrelated durable tags", () => {
    expect(routeSessionHarness({
      host: "central",
      tags: ["source-channel:telegram", "harness:pi"],
    })).toBeUndefined()
  })
})
