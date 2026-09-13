import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { verifyTasksCapability } from "./capability"
import { createTasksRootCapability } from "./root-capability"

const root = { userId: "user-1", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" }

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

async function scopeOf(env: Record<string, string | undefined>, variables: Record<string, string>) {
  expect(variables.WORKSPACE_RUNTIME_TASKS_CAPABILITY).toMatch(/\S/)
  return await verifyTasksCapability(variables.WORKSPACE_RUNTIME_TASKS_CAPABILITY ?? "", env)
}

describe("the Tasks grant a cloud root is launched with", () => {
  test("reads and creates in its own project, and cannot start anywhere by default", async () => {
    const env = await signingEnv()
    const variables = await createTasksRootCapability({ signingEnv: env })(root)
    expect(Object.keys(variables).sort()).toEqual([
      "WORKSPACE_RUNTIME_TASKS_CAPABILITY",
      "WORKSPACE_RUNTIME_TASKS_OPERATIONS",
      "WORKSPACE_RUNTIME_TASKS_PROJECT",
    ])
    expect(variables.WORKSPACE_RUNTIME_TASKS_OPERATIONS).toBe("read,create")
    expect(variables.WORKSPACE_RUNTIME_TASKS_PROJECT).toBe(root.projectId)
    expect(await scopeOf(env, variables)).toEqual({ ...root, operations: ["read", "create"] })
  })

  test("starts a task only where the account lets agents act on other machines", async () => {
    const env = await signingEnv()
    const crossMachineWrites = vi.fn(async () => true)
    const variables = await createTasksRootCapability({ signingEnv: env, crossMachineWrites })(root)
    expect(variables.WORKSPACE_RUNTIME_TASKS_OPERATIONS).toBe("read,create,start")
    expect((await scopeOf(env, variables)).operations).toEqual(["read", "create", "start"])
    expect(crossMachineWrites).toHaveBeenCalledWith({ userId: root.userId, orgId: root.orgId })
  })

  test("cannot be minted by a deployment with no signing key", async () => {
    await expect(createTasksRootCapability({ signingEnv: {} })(root)).rejects.toThrow("runtime signing key")
  })
})
