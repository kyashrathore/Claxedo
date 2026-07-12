import { describe, expect, test } from "bun:test"
import {
  activeAtOption,
  activeSlashCommand,
  comparePromptAtGroups,
  promptAgentOptions,
  promptAtOptionKey,
  promptAtOptions,
  promptSlashCommands,
} from "./popover-controller"

describe("prompt popover controller", () => {
  test("builds at-options as agents, recent files, then searched files", async () => {
    const options = await promptAtOptions({
      agents: promptAgentOptions([
        { name: "build" },
        { name: "hidden", hidden: true },
        { name: "primary", mode: "primary" },
      ]),
      recentFiles: ["src/a.ts", "src/b.ts"],
      query: "src",
      searchFilesAndDirectories: async () => ["src/b.ts", "src/c.ts"],
    })

    expect(options).toEqual([
      { type: "agent", name: "build", display: "build" },
      { type: "file", path: "src/a.ts", display: "src/a.ts", recent: true },
      { type: "file", path: "src/b.ts", display: "src/b.ts", recent: true },
      { type: "file", path: "src/c.ts", display: "src/c.ts" },
    ])
    expect(["file", "recent", "agent"].sort((a, b) => comparePromptAtGroups({ category: a }, { category: b }))).toEqual([
      "agent",
      "recent",
      "file",
    ])
  })

  test("builds slash commands as custom commands before enabled builtin commands", () => {
    expect(
      promptSlashCommands({
        customCommands: [
          { name: "deploy", description: "Ship it", source: "skill" },
        ],
        commandOptions: [
          { id: "suggested.ignore", title: "Ignore", slash: "ignore" },
          { id: "disabled.ignore", title: "Disabled", slash: "disabled", disabled: true },
          { id: "missing.ignore", title: "Missing" },
          { id: "session.help", title: "Help", description: "Show help", keybind: "mod+/", slash: "help" },
        ],
      }),
    ).toEqual([
      {
        id: "custom.deploy",
        trigger: "deploy",
        title: "deploy",
        description: "Ship it",
        type: "custom",
        source: "skill",
      },
      {
        id: "session.help",
        trigger: "help",
        title: "Help",
        description: "Show help",
        keybind: "mod+/",
        type: "builtin",
      },
    ])
  })

  test("selects the active popover item or falls back to the first option", () => {
    const atItems = [
      { type: "agent" as const, name: "build", display: "build" },
      { type: "file" as const, path: "src/a.ts", display: "src/a.ts" },
    ]
    const slashItems = [
      { id: "custom.deploy", trigger: "deploy", title: "deploy", type: "custom" as const },
      { id: "session.help", trigger: "help", title: "Help", type: "builtin" as const },
    ]

    expect(promptAtOptionKey(atItems[0])).toBe("agent:build")
    expect(activeAtOption({ items: atItems, active: "file:src/a.ts" })).toBe(atItems[1])
    expect(activeAtOption({ items: atItems, active: "missing" })).toBe(atItems[0])
    expect(activeSlashCommand({ items: slashItems, active: "session.help" })).toBe(slashItems[1])
    expect(activeSlashCommand({ items: slashItems, active: "missing" })).toBe(slashItems[0])
  })
})
