import { describe, expect, test } from "vitest"
import {
  BUILTIN_AGENT_PLUGIN_ID,
  builtinGroupDefault,
  builtinPluginInstanceId,
  builtinToolGroupId,
  isBuiltinPluginInstanceId,
  resolveBuiltinGroupActivation,
} from "./plugin"

const GROUPS = ["attention", "documents", "processes", "review", "sessions", "subagents", "tasks", "workspaces"]

const local = { documentsInProcess: true }
const hosted = { documentsInProcess: false }

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
    expect(Object.fromEntries(GROUPS.map((id) => [id, builtinGroupDefault(id, local)]))).toEqual({
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
    expect(Object.fromEntries(GROUPS.map((id) => [id, builtinGroupDefault(id, hosted)]))).toEqual({
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
    const signed = (groupId: string) =>
      resolveBuiltinGroupActivation({ groupId, harnessId: "opencode", deployment: hosted, mode: "signed" })
    expect(signed("sessions")).toBe(true)
    expect(signed("tasks")).toBe(false)
    expect(signed("documents")).toBe(false)
    const machine = (groupId: string) =>
      resolveBuiltinGroupActivation({ groupId, harnessId: "opencode", deployment: local, mode: "unsigned" })
    expect(machine("documents")).toBe(true)
    expect(machine("tasks")).toBe(false)
  })
})

describe("what a decision does to a default", () => {
  test("a project override beats the deployment default in both directions", () => {
    expect(resolveBuiltinGroupActivation({
      groupId: "tasks", harnessId: "opencode", deployment: hosted, mode: "signed", projectOverride: true,
    })).toBe(true)
    expect(resolveBuiltinGroupActivation({
      groupId: "sessions", harnessId: "opencode", deployment: hosted, mode: "signed", projectOverride: false,
    })).toBe(false)
  })

  test("a user default decides a project that has not overridden it", () => {
    expect(resolveBuiltinGroupActivation({
      groupId: "tasks", harnessId: "opencode", deployment: hosted, mode: "signed", userDefault: true,
    })).toBe(true)
    expect(resolveBuiltinGroupActivation({
      groupId: "tasks", harnessId: "opencode", deployment: hosted, mode: "signed", userDefault: true, projectOverride: false,
    })).toBe(false)
  })

  test("a machine override decides an unsigned deployment", () => {
    expect(resolveBuiltinGroupActivation({
      groupId: "documents", harnessId: "opencode", deployment: local, mode: "unsigned", machineOverride: false,
    })).toBe(false)
    expect(resolveBuiltinGroupActivation({
      groupId: "tasks", harnessId: "opencode", deployment: local, mode: "unsigned", machineOverride: true,
    })).toBe(true)
  })
})
