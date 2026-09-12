import { describe, expect, test } from "bun:test"
import { utf8ByteLength } from "@claxedo/helpers/string"
import { TASKS_BOUNDS, type Preset, type Task } from "./contracts"
import { primaryConfiguration, refusalOf } from "./test-support/harness"
import { START_ORIGIN_PREFIX, startDigest, startFirstMessage, startInstructions, startOriginId } from "./start"

function preset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: overrides.id ?? "preset-1",
    revision: overrides.revision ?? 1,
    scopeId: overrides.scopeId ?? "scope-alpha",
    ownerId: overrides.ownerId ?? "owner-alpha",
    name: overrides.name ?? "Careful",
    instructions: overrides.instructions ?? "Read the tests before the code.",
    execution: overrides.execution ?? { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: overrides.configurations ?? {
      primary: primaryConfiguration(),
      review: primaryConfiguration({ harness: { id: "codex", access: "native" }, effort: "high" }),
    },
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    revision: overrides.revision ?? 1,
    scopeId: overrides.scopeId ?? "scope-alpha",
    projectId: overrides.projectId ?? "project-alpha",
    workspaceId: overrides.workspaceId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? "Ship the thing",
    description: overrides.description ?? "",
    status: overrides.status ?? "todo",
    childSetRevision: overrides.childSetRevision ?? 0,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  }
}

const digestInput = {
  scopeId: "scope-alpha",
  taskId: "task-1",
  taskRevision: 1,
  presetId: "preset-1",
  presetRevision: 1,
  slot: "primary",
  attempt: 1,
  placement: "local",
  configuration: primaryConfiguration(),
  instructions: "block",
} as const

describe("startOriginId", () => {
  test("renders the versioned origin for one slot attempt", () => {
    expect(startOriginId("scope-alpha", "task-1", "review", 2)).toBe(`${START_ORIGIN_PREFIX}:scope-alpha:task-1:review:2`)
  })

  test("two different origins never render the same string", () => {
    const first = startOriginId("org:1", "task-2", "primary", 1)
    const second = startOriginId("org", "1:task-2", "primary", 1)
    expect(first).not.toBe(second)
  })

  test("an attempt that is not a positive whole number is refused", async () => {
    for (const attempt of [0, -1, 1.5]) {
      const detail = await refusalOf(async () => startOriginId("scope-alpha", "task-1", "primary", attempt))
      expect(detail.code).toBe("invalid_input")
    }
  })
})

describe("startInstructions", () => {
  test("carries the preset instructions and the resolved group, running slot marked", () => {
    const block = startInstructions({ preset: preset(), slot: "review" })
    expect(block.text).toContain("Read the tests before the code.")
    expect(block.text).toContain("Running configuration: review")
    expect(block.text).toContain("- review (running now): codex (native)")
    expect(block.text).toContain("- primary: claude (native)")
    expect(block.text).toContain("effort: high")
    expect(block.text).toContain("effort: not set")
    expect(block.configuration.harness.id).toBe("codex")
    expect(block.instructionsBytesDropped).toBe(0)
    expect(block.transcriptBytesDropped).toBe(0)
  })

  test("says which placement the session runs in", () => {
    expect(startInstructions({ preset: preset(), slot: "primary" }).text).toContain("Placement: local")
    const cloud = preset({
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
    })
    expect(startInstructions({ preset: cloud, slot: "primary" }).text).toContain("Placement: cloud")
  })

  test("never names the selected plugins or skills, which the host materializes", () => {
    const cloud = preset({
      execution: {
        placement: "cloud",
        capabilities: {
          mode: "selected",
          plugins: [{ sourceId: "claxedo", pluginName: "reviewer" }],
          skills: [{ sourceId: "claxedo", skillName: "writing" }],
        },
      },
    })
    const text = startInstructions({ preset: cloud, slot: "primary" }).text
    expect(text).not.toContain("reviewer")
    expect(text).not.toContain("writing")
  })

  test("a slot the preset does not configure is refused", async () => {
    const detail = await refusalOf(async () => startInstructions({ preset: preset(), slot: "planning" }))
    expect(detail.code).toBe("invalid_input")
    expect(detail.fields).toEqual([{ path: "slot", reason: "unknown_value" }])
  })

  test("the transcript goes last and keeps its most recent turns", () => {
    const block = startInstructions({
      preset: preset(),
      slot: "primary",
      handoffTranscript: "first turn\nlast turn",
    })
    expect(block.text.indexOf("Read the tests")).toBeLessThan(block.text.indexOf("previous session"))
    expect(block.text.endsWith("last turn")).toBe(true)
  })

  test("an oversized transcript loses its oldest bytes and says how many", () => {
    const transcript = "é".repeat(TASKS_BOUNDS.instructionsMaxBytes) + "the last thing that happened"
    const block = startInstructions({ preset: preset(), slot: "primary", handoffTranscript: transcript })

    expect(utf8ByteLength(block.text)).toBeLessThanOrEqual(TASKS_BOUNDS.instructionsMaxBytes)
    expect(block.transcriptBytesDropped).toBeGreaterThan(0)
    expect(block.instructionsBytesDropped).toBe(0)
    expect(block.text).toContain("earlier turns dropped")
    expect(block.text.endsWith("the last thing that happened")).toBe(true)
    expect(block.text).toContain("Read the tests before the code.")
    expect(block.text).not.toContain("�")
  })

  test("instructions filling the whole budget yield their tail, with the group kept and the loss reported", () => {
    const written = "a".repeat(TASKS_BOUNDS.instructionsMaxBytes)
    const block = startInstructions({ preset: preset({ instructions: written }), slot: "primary" })

    expect(utf8ByteLength(block.text)).toBeLessThanOrEqual(TASKS_BOUNDS.instructionsMaxBytes)
    expect(block.instructionsBytesDropped).toBeGreaterThan(0)
    expect(block.text).toContain("preset instructions truncated")
    expect(block.text).toContain("Running configuration: primary")
    expect(block.text.startsWith("aaa")).toBe(true)
  })

  test("both caps hold at once and the block never splits a character", () => {
    const block = startInstructions({
      preset: preset({ instructions: "é".repeat(TASKS_BOUNDS.instructionsMaxBytes / 2) }),
      slot: "primary",
      handoffTranscript: "é".repeat(TASKS_BOUNDS.instructionsMaxBytes),
    })
    expect(utf8ByteLength(block.text)).toBeLessThanOrEqual(TASKS_BOUNDS.instructionsMaxBytes)
    expect(block.text).not.toContain("�")
    expect(block.instructionsBytesDropped).toBeGreaterThan(0)
    expect(block.transcriptBytesDropped).toBeGreaterThan(0)
  })

  test("an empty preset instruction still produces the group", () => {
    const block = startInstructions({ preset: preset({ instructions: "   " }), slot: "primary" })
    expect(block.text.startsWith("## How this session is configured")).toBe(true)
  })
})

describe("startFirstMessage", () => {
  test("is the task in the user's words", () => {
    expect(startFirstMessage({ task: task({ description: "With the tests first." }) })).toBe(
      "Ship the thing\n\nWith the tests first.",
    )
  })

  test("omits an absent description and appends explicit handoff text", () => {
    expect(startFirstMessage({ task: task() })).toBe("Ship the thing")
    expect(startFirstMessage({ task: task(), handoffText: "  Start from the spike  " })).toBe(
      "Ship the thing\n\n## Where to pick up\nStart from the spike",
    )
    expect(startFirstMessage({ task: task(), handoffText: "   " })).toBe("Ship the thing")
  })
})

describe("startDigest", () => {
  test("is stable for one resolution and ignores key order", async () => {
    const first = await startDigest(digestInput)
    const reordered = await startDigest({
      instructions: digestInput.instructions,
      configuration: primaryConfiguration(),
      placement: "local",
      attempt: 1,
      slot: "primary",
      presetRevision: 1,
      presetId: "preset-1",
      taskRevision: 1,
      taskId: "task-1",
      scopeId: "scope-alpha",
    })
    expect(first).toBe(reordered)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test("moves when anything the session was resolved from moves", async () => {
    const base = await startDigest(digestInput)
    const changes = [
      { ...digestInput, taskRevision: 2 },
      { ...digestInput, presetRevision: 2 },
      { ...digestInput, attempt: 2 },
      { ...digestInput, slot: "review" as const },
      { ...digestInput, placement: "cloud" as const },
      { ...digestInput, instructions: "block with one more line" },
      { ...digestInput, configuration: primaryConfiguration({ effort: "high" }) },
      { ...digestInput, configuration: primaryConfiguration({ model: { providerID: "anthropic", modelID: "other" } }) },
      { ...digestInput, configuration: primaryConfiguration({ harness: { id: "codex", access: "native" } }) },
    ]
    for (const change of changes) {
      expect(await startDigest(change)).not.toBe(base)
    }
  })
})
