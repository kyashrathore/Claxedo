import { describe, expect, test } from "bun:test"
import { TASKS_BOUNDS } from "../contracts"
import { parsedReasons } from "../test-support/refusals"
import { presetDraft, primaryConfiguration } from "../test-support/rows"
import { parseCommandRequest, parsePresetListQuery, parseStartRequest, parseTaskListQuery } from "./parse"

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
    expect(parsedReasons(parseCommandRequest({ clientRequestId: "r", command: { type: "task.delete", input: {} } }))).toEqual({
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
    expect(parsedReasons(result)).toEqual({ "command.input.execution.capabilities.plugins": "not_allowed" })
  })

  test("a configuration slot the package does not define is refused, not ignored", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "preset.create",
        input: { ...presetDraft(), configurations: { primary: primaryConfiguration(), deployment: primaryConfiguration() } },
      },
    })
    expect(parsedReasons(result)).toEqual({ "command.input.configurations.deployment": "unknown_value" })
  })

  test("an empty effort is a missing value, and null is an explicit absence", () => {
    const withEmpty = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "preset.create",
        input: { ...presetDraft(), configurations: { primary: { ...primaryConfiguration(), effort: "" } } },
      },
    })
    expect(parsedReasons(withEmpty)).toEqual({ "command.input.configurations.primary.effort": "required" })

    const withNull = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "preset.create", input: presetDraft() },
    })
    expect(withNull.ok).toBe(true)
  })

  test("a preset draft says whether agents may start it, as a boolean and nothing else", () => {
    const { agentStartable: _agentStartable, ...unsaid } = presetDraft()
    expect(parsedReasons(parseCommandRequest({ clientRequestId: "r", command: { type: "preset.create", input: unsaid } }))).toEqual({
      "command.input.agentStartable": "required",
    })
    expect(
      parsedReasons(
        parseCommandRequest({
          clientRequestId: "r",
          command: { type: "preset.edit", input: { presetId: "preset-1", revision: 1, ...presetDraft(), agentStartable: "yes" } },
        }),
      ),
    ).toEqual({ "command.input.agentStartable": "type" })

    const marked = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "preset.create", input: presetDraft({ agentStartable: true }) },
    })
    expect(marked.ok && marked.value.command.type === "preset.create" && marked.value.command.input.agentStartable).toBe(true)
  })

  test("a number where a string belongs is a typed field, never a coerced one", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: 7, title: "Ship", description: "", workspaceId: null, parentTaskId: null },
      },
    })
    expect(parsedReasons(result)).toEqual({ "command.input.projectId": "type" })
  })

  test("a create carries Backlog, defaults to To do and refuses anything else", () => {
    const parked = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: "p", title: "Ship", description: "", workspaceId: null, parentTaskId: null, status: "backlog" },
      },
    })
    expect(parked.ok && parked.value.command.type === "task.create" && parked.value.command.input.status).toBe("backlog")

    const unsaid = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: "p", title: "Ship", description: "", workspaceId: null, parentTaskId: null },
      },
    })
    expect(unsaid.ok && unsaid.value.command.type === "task.create" && unsaid.value.command.input.status).toBeUndefined()

    const working = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: "p", title: "Ship", description: "", workspaceId: null, parentTaskId: null, status: "doing" },
      },
    })
    expect(parsedReasons(working)).toEqual({ "command.input.status": "unknown_value" })
  })

  test("a create carries the session it came from, or says nothing and came from the app", () => {
    const fromSession = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: {
          projectId: "p",
          title: "Ship",
          description: "",
          workspaceId: null,
          parentTaskId: null,
          createdFrom: { sessionId: "ses_1", workspaceId: null },
        },
      },
    })
    expect(fromSession.ok && fromSession.value.command.type === "task.create" && fromSession.value.command.input.createdFrom).toEqual({
      sessionId: "ses_1",
      workspaceId: null,
    })

    const fromTheApp = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: { projectId: "p", title: "Ship", description: "", workspaceId: null, parentTaskId: null },
      },
    })
    expect(
      fromTheApp.ok && fromTheApp.value.command.type === "task.create" && fromTheApp.value.command.input.createdFrom,
    ).toBeUndefined()

    const halfWritten = parseCommandRequest({
      clientRequestId: "r",
      command: {
        type: "task.create",
        input: {
          projectId: "p",
          title: "Ship",
          description: "",
          workspaceId: null,
          parentTaskId: null,
          createdFrom: { workspaceId: "ws_1" },
        },
      },
    })
    expect(parsedReasons(halfWritten)).toEqual({ "command.input.createdFrom.sessionId": "required" })
  })

  test("a status outside the closed set is refused", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "task.set_status", input: { taskId: "task-1", revision: 1, status: "blocked" } },
    })
    expect(parsedReasons(result)).toEqual({ "command.input.status": "unknown_value" })
  })

  test("a fractional revision is out of range", () => {
    const result = parseCommandRequest({
      clientRequestId: "r",
      command: { type: "task.archive", input: { taskId: "task-1", revision: 1.5 } },
    })
    expect(parsedReasons(result)).toEqual({ "command.input.revision": "out_of_range" })
  })
})

describe("parseStartRequest", () => {
  test("accepts a complete request", () => {
    expect(parseStartRequest(startBody).ok).toBe(true)
  })

  test("bounds the handoff text", () => {
    const long = { ...startBody, handoffText: "x".repeat(TASKS_BOUNDS.handoffTextMaxBytes + 1) }
    expect(parsedReasons(parseStartRequest(long))).toEqual({ handoffText: "too_long" })
  })

  test("a slot outside the closed set is refused", () => {
    expect(parsedReasons(parseStartRequest({ ...startBody, slot: "deployment" }))).toEqual({ slot: "unknown_value" })
  })
})

describe("query parsing", () => {
  test("defaults are explicit and out-of-range limits are refused", () => {
    const bare = parsePresetListQuery(new URLSearchParams())
    expect(bare.ok && bare.value).toEqual({ cursor: null, limit: TASKS_BOUNDS.listLimitDefault, includeArchived: false })
    expect(parsedReasons(parsePresetListQuery(new URLSearchParams("limit=0")))).toEqual({ limit: "out_of_range" })
    expect(parsedReasons(parsePresetListQuery(new URLSearchParams("limit=101")))).toEqual({ limit: "out_of_range" })
  })

  test("a task list names the project it is scoped to", () => {
    expect(parsedReasons(parseTaskListQuery(new URLSearchParams()))).toEqual({ projectId: "required" })
    const parsed = parseTaskListQuery(new URLSearchParams("projectId=project-alpha&status=doing&parent=root"))
    expect(parsed.ok && parsed.value).toMatchObject({ projectId: "project-alpha", status: "doing", parent: "root" })
    expect(parsedReasons(parseTaskListQuery(new URLSearchParams("projectId=p&status=blocked")))).toEqual({
      status: "unknown_value",
    })
  })
})
