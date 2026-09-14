import { describe, expect, test } from "vitest"
import {
  BUILTIN_AGENT_PLUGIN_ID,
  builtinGroupDefault,
  builtinPluginInstanceId,
  builtinToolGroupId,
  isBuiltinPluginInstanceId,
  resolveBuiltinGroupActivation,
  type BuiltinToolGroup,
} from "./plugin"

/** The reaches the serving package declares, as this rule sees them. */
const GROUPS: BuiltinToolGroup[] = [
  { id: "attention", reach: "runtime", tools: [] },
  { id: "documents", reach: { service: "documents" }, tools: [] },
  { id: "processes", reach: "runtime", tools: [] },
  { id: "review", reach: "runtime", tools: [] },
  { id: "sessions", reach: "runtime", tools: [] },
  { id: "subagents", reach: "runtime", tools: [] },
  { id: "tasks", reach: "account", tools: [] },
  { id: "workspaces", reach: "runtime", tools: [] },
]

const group = (id: string) => GROUPS.find((candidate) => candidate.id === id)!

const local = { inProcessServices: ["documents"] }
const hosted = { inProcessServices: [] }

describe("the built-in plugin's activation subject", () => {
  test("each group is its own plugin instance, and only those ids are built in", () => {
    expect(builtinPluginInstanceId("tasks")).toBe("claxedo:tasks")
    expect(builtinToolGroupId("claxedo:tasks")).toBe("tasks")
    expect(builtinToolGroupId(BUILTIN_AGENT_PLUGIN_ID)).toBeUndefined()
    expect(builtinToolGroupId(JSON.stringify(["source_1", "review-plugin"]))).toBeUndefined()
    expect(isBuiltinPluginInstanceId("claxedo:sessions")).toBe(true)
    expect(isBuiltinPluginInstanceId("claxedo:a:b")).toBe(false)
  })
})

describe("what a project starts with", () => {
  test("local: every group but Tasks, because the documents service is this process", () => {
    expect(Object.fromEntries(GROUPS.map((entry) => [entry.id, builtinGroupDefault(entry, local)]))).toEqual({
      attention: true,
      documents: true,
      processes: true,
      review: true,
      sessions: true,
      subagents: true,
      tasks: false,
      workspaces: true,
    })
  })

  test("hosted: Documents is an account service, so it is off with Tasks", () => {
    expect(Object.fromEntries(GROUPS.map((entry) => [entry.id, builtinGroupDefault(entry, hosted)]))).toEqual({
      attention: true,
      documents: false,
      processes: true,
      review: true,
      sessions: true,
      subagents: true,
      tasks: false,
      workspaces: true,
    })
  })

  test("a project with no record of its own gets the deployment's defaults", () => {
    const signed = (id: string) =>
      resolveBuiltinGroupActivation({ group: group(id), harnessId: "opencode", deployment: hosted, mode: "signed" })
    expect(signed("sessions")).toBe(true)
    expect(signed("tasks")).toBe(false)
    expect(signed("documents")).toBe(false)
    const machine = (id: string) =>
      resolveBuiltinGroupActivation({ group: group(id), harnessId: "opencode", deployment: local, mode: "unsigned" })
    expect(machine("documents")).toBe(true)
    expect(machine("tasks")).toBe(false)
  })
})

describe("a group this rule has never seen", () => {
  test("is granted only by what it declares, never by not being recognised", () => {
    // The rule that reads this ships before the group that trips it. A group
    // added tomorrow gets the default its own registration asked for, and a
    // deployment that does not run the service it names does not hand it over.
    expect(builtinGroupDefault({ id: "invented", reach: "account", tools: [] }, local)).toBe(false)
    expect(builtinGroupDefault({ id: "invented", reach: { service: "ledger" }, tools: [] }, local)).toBe(false)
    expect(builtinGroupDefault({ id: "invented", reach: { service: "ledger" }, tools: [] }, {
      inProcessServices: ["documents", "ledger"],
    })).toBe(true)
    expect(builtinGroupDefault({ id: "invented", reach: "runtime", tools: [] }, hosted)).toBe(true)
  })
})

describe("what a decision does to a default", () => {
  test("a project override beats the deployment default in both directions", () => {
    expect(resolveBuiltinGroupActivation({
      group: group("tasks"), harnessId: "opencode", deployment: hosted, mode: "signed", projectOverride: true,
    })).toBe(true)
    expect(resolveBuiltinGroupActivation({
      group: group("sessions"), harnessId: "opencode", deployment: hosted, mode: "signed", projectOverride: false,
    })).toBe(false)
  })

  test("a user default decides a project that has not overridden it", () => {
    expect(resolveBuiltinGroupActivation({
      group: group("tasks"), harnessId: "opencode", deployment: hosted, mode: "signed", userDefault: true,
    })).toBe(true)
    expect(resolveBuiltinGroupActivation({
      group: group("tasks"), harnessId: "opencode", deployment: hosted, mode: "signed", userDefault: true, projectOverride: false,
    })).toBe(false)
  })

  test("a machine override decides an unsigned deployment", () => {
    expect(resolveBuiltinGroupActivation({
      group: group("documents"), harnessId: "opencode", deployment: local, mode: "unsigned", machineOverride: false,
    })).toBe(false)
    expect(resolveBuiltinGroupActivation({
      group: group("tasks"), harnessId: "opencode", deployment: local, mode: "unsigned", machineOverride: true,
    })).toBe(true)
  })
})
