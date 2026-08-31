import { describe, expect, test } from "bun:test"
import { codexAppServerCommand, codexPluginLaunch } from "./driver"

describe("Codex Agent Plugins launch", () => {
  const launch = {
    config: {
      marketplace: { name: "claxedo-agent-plugins", source: "/runtime/generation-4" },
      plugins: ["composio@claxedo-agent-plugins"],
    },
  }

  test("validates the generated marketplace while Codex reads it from its managed config", () => {
    const parsed = codexPluginLaunch(launch)
    expect(parsed).toEqual(launch.config)
    expect(codexAppServerCommand("codex")).toEqual({
      command: "codex",
      args: [
        "app-server",
        "--listen", "stdio://",
      ],
    })
    expect(codexAppServerCommand("/tmp/codex.js")).toEqual({
      command: process.execPath,
      args: [
        "/tmp/codex.js",
        "app-server",
        "--listen", "stdio://",
      ],
    })
  })

  test("rejects unsafe launch values and omits overrides when no plugins are active", () => {
    expect(codexPluginLaunch({ config: {} })).toBeUndefined()
    expect(() => codexPluginLaunch({ config: {
      marketplace: { name: "unsafe name", source: "/runtime/generation-4" },
      plugins: ["composio@unsafe name"],
    } })).toThrow("invalid marketplace name")
    expect(() => codexPluginLaunch({ config: {
      marketplace: { name: "market", source: "relative" },
      plugins: ["composio@market"],
    } })).toThrow("invalid marketplace source")
    expect(() => codexPluginLaunch({ config: {
      marketplace: { name: "market", source: "/runtime/generation-4" },
      plugins: ["composio@other"],
    } })).toThrow("invalid plugin id")
    expect(codexAppServerCommand("codex").args).toEqual(["app-server", "--listen", "stdio://"])
  })
})
