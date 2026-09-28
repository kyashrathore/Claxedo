import { describe, expect, test } from "bun:test"
import {
  activeAtOption,
  activeSlashCommand,
  comparePromptAtGroups,
  promptAgentOptions,
  promptAtOptionKey,
  promptAtOptions,
  promptDocumentOptions,
  promptSlashCommands,
  promptCustomCommands,
} from "./prompt-options"

describe("prompt popover controller", () => {
  test("builds at-options as agents, recent files, then searched files", async () => {
    const options = await promptAtOptions({
      agents: promptAgentOptions([
        { name: "build", mode: "subagent" },
        { name: "hidden", mode: "subagent", hidden: true },
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
    expect(["file", "recent", "agent"].sort((a, b) => comparePromptAtGroups({ category: a }, { category: b }))).toEqual(
      ["agent", "recent", "file"],
    )
  })

  test("offers only agents whose mode declares them delegable", () => {
    expect(
      promptAgentOptions([
        { name: "reviewer", mode: "subagent" },
        { name: "generalist", mode: "all" },
        { name: "build", mode: "primary" },
        { name: "unclassified" },
      ]),
    ).toEqual([
      { type: "agent", name: "reviewer", display: "reviewer" },
      { type: "agent", name: "generalist", display: "generalist" },
    ])
  })

  test("shows the agent's argument hint without changing the slash command text", () => {
    const list = promptSlashCommands({
      customCommands: [{ origin: "transport", name: "review", description: "Review changes", input: { hint: "<path>" } }],
      commandOptions: [],
    })
    expect(list.find((command) => command.id === "custom.transport.review")).toMatchObject({
      trigger: "review", description: "Review changes · <path>", type: "custom",
    })
  })

  test("builds slash commands as custom commands before enabled builtin commands", () => {
    expect(
      promptSlashCommands({
        customCommands: [{ origin: "transport", name: "deploy", description: "Ship it", source: "skill" }],
        commandOptions: [
          { id: "suggested.ignore", title: "Ignore", slash: "ignore" },
          { id: "disabled.ignore", title: "Disabled", slash: "disabled", disabled: true },
          { id: "missing.ignore", title: "Missing" },
          { id: "session.help", title: "Help", description: "Show help", keybind: "mod+/", slash: "help" },
        ],
      }),
    ).toEqual([
      {
        id: "documents.open",
        trigger: "docs",
        title: "Documents",
        description: "Attach a document as an editable file",
        type: "builtin",
      },
      {
        id: "custom.transport.deploy",
        origin: "transport",
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

  test("provider commands cannot shadow a reserved built-in Goal", () => {
    const commands = promptSlashCommands({
      customCommands: [{ origin: "transport", name: "goal", description: "Provider shadow" }],
      commandOptions: [{ id: "prompt.goal", title: "Goal", slash: "goal" }],
    })

    expect(commands.filter((command) => command.trigger === "goal")).toEqual([
      { id: "prompt.goal", trigger: "goal", title: "Goal", description: undefined, keybind: undefined, type: "builtin" },
    ])
  })

  test("leaves non-Goal provider command precedence unchanged", () => {
    const commands = promptSlashCommands({
      customCommands: [{ origin: "transport", name: "help", description: "Provider help" }],
      commandOptions: [{ id: "session.help", title: "Help", slash: "help" }],
    })

    expect(commands.filter((command) => command.trigger === "help").map((command) => ({ id: command.id, type: command.type }))).toEqual([
      { id: "custom.transport.help", type: "custom" },
      { id: "session.help", type: "builtin" },
    ])
  })

  test("builds document picker options from content-free index metadata", () => {
    expect(
      promptDocumentOptions([
        { documentId: "doc-1", displayName: "Plan", originKind: "managed", placementKind: "local", status: "draft" },
      ]),
    ).toEqual([
      {
        type: "document",
        documentId: "doc-1",
        display: "Plan",
        originKind: "managed",
        placementKind: "local",
        status: "draft",
      },
    ])
  })

  test("selects the active popover item or falls back to the first option", () => {
    const atItems = [
      { type: "agent" as const, name: "build", display: "build" },
      { type: "file" as const, path: "src/a.ts", display: "src/a.ts" },
    ]
    const slashItems = [
      { id: "custom.transport.deploy", trigger: "deploy", title: "deploy", type: "custom" as const, origin: "transport" as const },
      { id: "session.help", trigger: "help", title: "Help", type: "builtin" as const },
    ]

    expect(promptAtOptionKey(atItems[0])).toBe("agent:build")
    expect(activeAtOption({ items: atItems, active: "file:src/a.ts" })).toBe(atItems[1])
    expect(activeAtOption({ items: atItems, active: "missing" })).toBe(atItems[0])
    expect(activeSlashCommand({ items: slashItems, active: "session.help" })).toBe(slashItems[1])
    expect(activeSlashCommand({ items: slashItems, active: "missing" })).toBe(slashItems[0])
  })
})

test("colliding saved and transport commands keep distinct identities and selection", () => {
  const commands = promptSlashCommands({ commandOptions: [], customCommands: [
    { name: "review", origin: "saved", content: "Review my saved instructions" },
    { name: "review", origin: "transport", description: "Harness review" },
  ] })
  expect(commands.filter((command) => command.type === "custom").map((command) => command.id)).toEqual([
    "custom.saved.review", "custom.transport.review",
  ])
  expect(activeSlashCommand({ items: commands, active: "custom.saved.review" })).toMatchObject({ origin: "saved", content: "Review my saved instructions" })
  expect(activeSlashCommand({ items: commands, active: "custom.transport.review" })).toMatchObject({ origin: "transport", trigger: "review" })
})

test("session command announcements replace transport entries while retaining saved commands", () => {
  expect(promptCustomCommands([
    { name: "review", origin: "saved", content: "Saved review" },
    { name: "old", origin: "transport" },
  ], [{ name: "review", description: "Live harness command" }])).toEqual([
    { name: "review", origin: "saved", content: "Saved review" },
    { name: "review", origin: "transport", description: "Live harness command" },
  ])
})
