import { describe, expect, test, vi } from "vitest"
import { workspaceRuntimeTasksCapabilityEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { workspaceRuntimeTasksGrant } from "./tasks-grant"

const AUTHORITY = { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://plane.test/api/runtime-authority/session-authorize" }

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...AUTHORITY,
    ...workspaceRuntimeTasksCapabilityEnv({
      token: "capability-token",
      operations: ["read", "create"],
      projectId: "project-a",
    }),
    ...overrides,
  }
}

describe("the Tasks grant a cloud root is launched with", () => {
  test("reaches the control plane the runtime already answers to, as the capability", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    try {
      const grant = workspaceRuntimeTasksGrant(env())
      expect(grant?.operations).toEqual(["read", "create"])
      expect(grant?.projectId).toBe("project-a")
      await grant?.fetch("/api/claxedo/tasks/tasks?projectId=project-a")
      const request = fetch.mock.calls[0]?.[0] as Request | undefined
      expect(request?.url).toBe("https://plane.test/api/claxedo/tasks/tasks?projectId=project-a")
      expect(request?.headers.get("authorization")).toBe("Bearer capability-token")
    } finally {
      fetch.mockRestore()
    }
  })

  test("replaces an authorization a caller tried to set itself", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    try {
      const grant = workspaceRuntimeTasksGrant(env())
      await grant?.fetch("/api/claxedo/tasks/tasks", { headers: { authorization: "Bearer something-else" } })
      const request = fetch.mock.calls[0]?.[0] as Request | undefined
      expect(request?.headers.get("authorization")).toBe("Bearer capability-token")
    } finally {
      fetch.mockRestore()
    }
  })

  test("is absent without a capability, without a control plane, or with nothing granted", () => {
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "" }))).toBeUndefined()
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "" }))).toBeUndefined()
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_OPERATIONS: "" }))).toBeUndefined()
  })

  test("drops an operation this build does not have", () => {
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_OPERATIONS: "read,delete,start" }))?.operations)
      .toEqual(["read", "start"])
  })
})
