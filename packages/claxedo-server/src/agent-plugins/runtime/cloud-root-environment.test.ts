import { describe, expect, test, vi } from "vitest"
import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import { builtinPluginInstanceId, builtinToolGroupId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  WORKSPACE_RUNTIME_MCP_TOOL_GROUPS,
  workspaceRuntimeMcpToolGroups,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createCloudRootEnvironment } from "./cloud-root-environment"

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
