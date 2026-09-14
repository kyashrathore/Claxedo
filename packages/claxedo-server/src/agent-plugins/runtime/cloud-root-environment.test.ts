import { describe, expect, test, vi } from "vitest"
import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import { builtinPluginInstanceId, builtinToolGroupId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  WORKSPACE_RUNTIME_MCP_TOOL_GROUPS,
  workspaceRuntimeMcpToolGroups,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createCloudRootEnvironment, createTasksGroupReader } from "./cloud-root-environment"

const root = { userId: "user-1", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" }

/** The hosted deployment: no service runs in the control plane's own process. */
const builtIn = { groups: claxedoMcpToolGroupInventory(), deployment: { inProcessServices: [] } }

const RUNTIME_GROUPS = builtIn.groups.filter((group) => group.reach === "runtime").map((group) => group.id)

function activations(overrides: Record<string, boolean> = {}) {
  return {
    readRuntime: vi.fn(async (input: { pluginInstanceId: string; harnessId: string; projectId: string }): Promise<SignedActivationSnapshot> => {
      const group = builtinToolGroupId(input.pluginInstanceId) ?? ""
      return {
        revision: 1,
        pluginInstanceId: input.pluginInstanceId,
        harnessId: "opencode",
        projectId: input.projectId,
        ...(group in overrides ? { projectOverride: overrides[group] } : {}),
        pins: {},
      }
    }),
  }
}

describe("whether a cloud root's project has Tasks on", () => {
  test("answers from the Tasks group's own activation, read once as the workspace's owner", async () => {
    const on = activations({ tasks: true })
    await expect(createTasksGroupReader({ activations: on, builtIn })(root)).resolves.toBe(true)
    expect(on.readRuntime).toHaveBeenCalledTimes(1)
    expect(on.readRuntime).toHaveBeenCalledWith({
      ownerUserId: root.userId,
      organizationId: root.orgId,
      projectId: root.projectId,
      workspaceId: root.workspaceId,
      pluginInstanceId: builtinPluginInstanceId("tasks"),
      harnessId: "opencode",
    })
    await expect(createTasksGroupReader({ activations: activations({ tasks: false }), builtIn })(root)).resolves.toBe(false)
    await expect(createTasksGroupReader({ activations: activations(), builtIn })(root)).resolves.toBe(false)
  })

  test("agrees with the launch environment about the same root", async () => {
    for (const tasks of [true, false]) {
      const store = activations({ tasks })
      const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant: async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "t" }) })(root)
      expect(await createTasksGroupReader({ activations: store, builtIn })(root)).toBe("WORKSPACE_RUNTIME_TASKS_CAPABILITY" in environment)
    }
  })

  test("a build whose first-party server registers no Tasks group answers off", async () => {
    const reader = createTasksGroupReader({
      activations: activations({ tasks: true }),
      builtIn: { groups: builtIn.groups.filter((group) => group.id !== "tasks"), deployment: builtIn.deployment },
    })
    await expect(reader(root)).resolves.toBe(false)
  })
})

describe("the first-party environment a cloud root boots with", () => {
  test("declares the groups the project has on, readable by the runtime's own parser, and no Tasks grant while Tasks is off", async () => {
    const store = activations({ attention: false })
    const tasksGrant = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" }))
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant })(root)

    expect(RUNTIME_GROUPS).toContain("attention")
    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual(RUNTIME_GROUPS.filter((group) => group !== "attention"))
    expect(environment).toEqual({ [WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]: expect.any(String) })
    expect(tasksGrant).not.toHaveBeenCalled()
  })

  test("carries the Tasks grant once the project turned Tasks on", async () => {
    const store = activations({ tasks: true })
    const tasksGrant = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" }))
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant })(root)

    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual(
      builtIn.groups.filter((group) => group.reach === "runtime" || group.id === "tasks").map((group) => group.id),
    )
    expect(environment.WORKSPACE_RUNTIME_TASKS_CAPABILITY).toBe("grant-token")
    expect(tasksGrant).toHaveBeenCalledWith(root)
  })

  test("reads each group's activation as the workspace's recorded owner, for the harness the runtime serves", async () => {
    const store = activations()
    await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant: async () => ({}) })(root)

    expect(store.readRuntime).toHaveBeenCalledTimes(builtIn.groups.length)
    expect(store.readRuntime).toHaveBeenCalledWith({
      ownerUserId: root.userId,
      organizationId: root.orgId,
      projectId: root.projectId,
      workspaceId: root.workspaceId,
      pluginInstanceId: builtinPluginInstanceId("sessions"),
      harnessId: "opencode",
    })
  })

  test("a project that turned everything off launches with an empty declaration, not an absent one", async () => {
    const store = activations(Object.fromEntries(builtIn.groups.map((group) => [group.id, false])))
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant: async () => ({}) })(root)

    expect(environment).toEqual({ [WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]: "" })
    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual([])
  })
})
