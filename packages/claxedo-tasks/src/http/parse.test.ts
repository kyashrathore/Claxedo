import { describe, expect, test } from "bun:test"
import { TASKS_BOUNDS } from "../contracts"
import { presetDraft, primaryConfiguration } from "../test-support/harness"
import type { Parsed } from "../validation"
import { parseCommandRequest, parsePresetListQuery, parseStartRequest, parseTaskListQuery } from "./parse"

function reasons<T>(result: Parsed<T>): Record<string, string> {
  return result.ok ? {} : Object.fromEntries(result.fields.map((field) => [field.path, field.reason]))
}

const startBody = {
  clientRequestId: "request-1",
  taskRevision: 1,
  presetId: "preset-1",
  presetRevision: 1,
  slot: "primary",
  attempt: 1,
  previewDigest: "digest-1",
  handoffText: null,
  continueFromPrevious: false,
}

describe("parseCommandRequest", () => {
  test("accepts a well-formed command", () => {
    const result = parseCommandRequest({
      clientRequestId: "request-1",
      command: { type: "preset.create", input: presetDraft() },
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.command.type).toBe("preset.create")
  })

  test("a command name outside the closed set is refused before its input is read", () => {
    expect(reasons(parseCommandRequest({ clientRequestId: "r", command: { type: "task.delete", input: {} } }))).toEqual({
      "command.type": "unknown_value",
    })
  })

  test("a local preset may not carry a capability selection", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "preset.create",
        input: {
          ...presetDraft(),
          execution: {
            placement: "local",
            capabilities: { mode: "inherit-local", plugins: [{ sourceId: "claxedo", pluginName: "review" }] },
          },
        },
      },
    })
    expect(reasons(result)).toEqual({ "command.input.execution.capabilities.plugins": "not_allowed" })
  })

  test("a configuration slot the package does not define is refused, not ignored", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "preset.create",
        input: { ...presetDraft(), configurations: { primary: primaryConfiguration(), deployment: primaryConfiguration() } },
      },
    })
    expect(reasons(result)).toEqual({ "command.input.configurations.deployment": "unknown_value" })
  })

  test("an empty effort is a missing value, and null is an explicit absence", () => {
    const withEmpty = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "preset.create",
        input: { ...presetDraft(), configurations: { primary: { ...primaryConfiguration(), effort: "" } } },
      },
    })
    expect(reasons(withEmpty)).toEqual({ "command.input.configurations.primary.effort": "required" })

    const withNull = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "preset.create", input: presetDraft() },
    })
    expect(withNull.ok).toBe(true)
  })

  test("a number where a string belongs is a typed field, never a coerced one", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: 7, title: "Ship", description: "", workspaceId: null, parentTaskId: null },
      },
    })
    expect(reasons(result)).toEqual({ "command.input.projectId": "type" })
  })

  test("a status outside the closed set is refused", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "task.set_status", input: { taskId: "task-1", revision: 1, status: "blocked" } },
    })
    expect(reasons(result)).toEqual({ "command.input.status": "unknown_value" })
  })

  test("a fractional revision is out of range", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "task.archive", input: { taskId: "task-1", revision: 1.5 } },
    })
    expect(reasons(result)).toEqual({ "command.input.revision": "out_of_range" })
  })
})

describe("parseStartRequest", () => {
  test("accepts a complete request", () => {
    expect(parseStartRequest(startBody).ok).toBe(true)
  })

  test("bounds the handoff text", () => {
    const long = { ...startBody, handoffText: "x".repeat(TASKS_BOUNDS.handoffTextMaxBytes + 1) }
    expect(reasons(parseStartRequest(long))).toEqual({ handoffText: "too_long" })
  })

  test("a slot outside the closed set is refused", () => {
    expect(reasons(parseStartRequest({ ...startBody, slot: "deployment" }))).toEqual({ slot: "unknown_value" })
  })
})

describe("query parsing", () => {
  test("defaults are explicit and out-of-range limits are refused", () => {
    const bare = parsePresetListQuery(new URLSearchParams())
    expect(bare.ok && bare.value).toEqual({ cursor: null, limit: TASKS_BOUNDS.listLimitDefault, includeArchived: false })
    expect(reasons(parsePresetListQuery(new URLSearchParams("limit=0")))).toEqual({ limit: "out_of_range" })
    expect(reasons(parsePresetListQuery(new URLSearchParams("limit=101")))).toEqual({ limit: "out_of_range" })
  })

  test("a task list names the project it is scoped to", () => {
    expect(reasons(parseTaskListQuery(new URLSearchParams()))).toEqual({ projectId: "required" })
    const parsed = parseTaskListQuery(new URLSearchParams("projectId=project-alpha&status=doing&parent=root"))
    expect(parsed.ok && parsed.value).toMatchObject({ projectId: "project-alpha", status: "doing", parent: "root" })
    expect(reasons(parseTaskListQuery(new URLSearchParams("projectId=p&status=blocked")))).toEqual({
      status: "unknown_value",
    })
  })
})
