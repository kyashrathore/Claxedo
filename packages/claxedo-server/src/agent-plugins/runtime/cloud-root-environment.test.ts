import { describe, expect, test, vi } from "vitest"
import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import { builtinPluginInstanceId, builtinToolGroupId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  WORKSPACE_RUNTIME_MCP_TOOL_GROUPS,
  WORKSPACE_RUNTIME_OWNER_GRANT,
  workspaceRuntimeMcpToolGroups,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createBuiltinGroupReader, createCloudRootEnvironment } from "./cloud-root-environment"

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

/** What every test launches with unless it says otherwise: grants that carry their env name, so the sweep can tell them apart. */
const grants = {
  tasksGrant: async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "tasks-token" }),
  ownerGrant: async () => ({ [WORKSPACE_RUNTIME_OWNER_GRANT]: "owner-token" }),
}

describe("whether a cloud root's project has a group on", () => {
  test("answers from the group's own activation, read once as the workspace's owner", async () => {
    const on = activations({ tasks: true })
    await expect(createBuiltinGroupReader({ activations: on, builtIn }, "tasks")(root)).resolves.toBe(true)
    expect(on.readRuntime).toHaveBeenCalledTimes(1)
    expect(on.readRuntime).toHaveBeenCalledWith({
      ownerUserId: root.userId,
      organizationId: root.orgId,
      projectId: root.projectId,
      workspaceId: root.workspaceId,
      pluginInstanceId: builtinPluginInstanceId("tasks"),
      harnessId: "opencode",
    })
    await expect(createBuiltinGroupReader({ activations: activations({ tasks: false }), builtIn }, "tasks")(root)).resolves.toBe(false)
    await expect(createBuiltinGroupReader({ activations: activations(), builtIn }, "tasks")(root)).resolves.toBe(false)
  })

  test("agrees with the launch environment about the same root, for the Tasks grant and the owner grant alike", async () => {
    for (const tasks of [true, false]) {
      for (const subagents of [true, false]) {
        const store = activations({ tasks, subagents })
        const environment = await createCloudRootEnvironment({ activations: store, builtIn, ...grants })(root)
        expect(await createBuiltinGroupReader({ activations: store, builtIn }, "tasks")(root)).toBe("WORKSPACE_RUNTIME_TASKS_CAPABILITY" in environment)
        expect(await createBuiltinGroupReader({ activations: store, builtIn }, "subagents")(root)).toBe(WORKSPACE_RUNTIME_OWNER_GRANT in environment)
      }
    }
  })

  test("a build whose first-party server registers no such group answers off", async () => {
    const reader = createBuiltinGroupReader({
      activations: activations({ tasks: true }),
      builtIn: { groups: builtIn.groups.filter((group) => group.id !== "tasks"), deployment: builtIn.deployment },
    }, "tasks")
    await expect(reader(root)).resolves.toBe(false)
    await expect(createBuiltinGroupReader({ activations: activations({ tasks: true }), builtIn }, "no-such-group")(root)).resolves.toBe(false)
  })
})

describe("the first-party environment a cloud root boots with", () => {
  test("declares the groups the project has on, readable by the runtime's own parser, and no Tasks grant while Tasks is off", async () => {
    const store = activations({ attention: false, subagents: false })
    const tasksGrant = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" }))
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant, ownerGrant: grants.ownerGrant })(root)

    expect(RUNTIME_GROUPS).toContain("attention")
    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual(RUNTIME_GROUPS.filter((group) => group !== "attention" && group !== "subagents"))
    expect(environment).toEqual({ [WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]: expect.any(String) })
    expect(tasksGrant).not.toHaveBeenCalled()
  })

  test("carries the Tasks grant once the project turned Tasks on", async () => {
    const store = activations({ tasks: true, subagents: false })
    const tasksGrant = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" }))
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, tasksGrant, ownerGrant: grants.ownerGrant })(root)

    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual(
      builtIn.groups.filter((group) => (group.reach === "runtime" && group.id !== "subagents") || group.id === "tasks").map((group) => group.id),
    )
    expect(environment.WORKSPACE_RUNTIME_TASKS_CAPABILITY).toBe("grant-token")
    expect(environment).not.toHaveProperty(WORKSPACE_RUNTIME_OWNER_GRANT)
    expect(tasksGrant).toHaveBeenCalledWith(root)
  })

  test("carries the owner grant exactly while the subagents group is on, whatever Tasks says", async () => {
    const ownerGrant = vi.fn(async () => ({ [WORKSPACE_RUNTIME_OWNER_GRANT]: "owner-token" }))
    // The subagents group reaches only the runtime, so a project that said nothing has it on.
    const silent = await createCloudRootEnvironment({ activations: activations(), builtIn, tasksGrant: grants.tasksGrant, ownerGrant })(root)
    expect(silent[WORKSPACE_RUNTIME_OWNER_GRANT]).toBe("owner-token")
    expect(silent).not.toHaveProperty("WORKSPACE_RUNTIME_TASKS_CAPABILITY")
    expect(ownerGrant).toHaveBeenCalledWith(root)

    const off = await createCloudRootEnvironment({ activations: activations({ subagents: false, tasks: true }), builtIn, tasksGrant: grants.tasksGrant, ownerGrant })(root)
    expect(off).not.toHaveProperty(WORKSPACE_RUNTIME_OWNER_GRANT)
    expect(off.WORKSPACE_RUNTIME_TASKS_CAPABILITY).toBe("tasks-token")
    expect(workspaceRuntimeMcpToolGroups(off)).not.toContain("subagents")
    expect(ownerGrant).toHaveBeenCalledTimes(1)

    const both = await createCloudRootEnvironment({ activations: activations({ subagents: true, tasks: true }), builtIn, tasksGrant: grants.tasksGrant, ownerGrant })(root)
    expect(both).toMatchObject({ [WORKSPACE_RUNTIME_OWNER_GRANT]: "owner-token", WORKSPACE_RUNTIME_TASKS_CAPABILITY: "tasks-token" })
  })

  test("a root whose owner grant cannot be minted is not launched", async () => {
    const environment = createCloudRootEnvironment({
      activations: activations({ subagents: true }),
      builtIn,
      tasksGrant: grants.tasksGrant,
      ownerGrant: async () => { throw new Error("Workspace ws_root has no owner this control plane can launch it as") },
    })
    await expect(environment(root)).rejects.toThrow("no owner this control plane can launch it as")
  })

  test("reads each group's activation as the workspace's recorded owner, for the harness the runtime serves", async () => {
    const store = activations()
    await createCloudRootEnvironment({ activations: store, builtIn, ...grants })(root)

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
    const environment = await createCloudRootEnvironment({ activations: store, builtIn, ...grants })(root)

    expect(environment).toEqual({ [WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]: "" })
    expect(workspaceRuntimeMcpToolGroups(environment)).toEqual([])
  })
})
