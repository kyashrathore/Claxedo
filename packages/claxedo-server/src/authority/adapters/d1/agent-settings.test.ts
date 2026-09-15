import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { createTasksRootCapability } from "../../../tasks/root-capability"
import { d1AgentSettings, d1CrossMachineWrites } from "./agent-settings"

const MIGRATIONS = ["0025_claxedo_tasks.sql", "0026_agent_cross_machine_writes.sql"]

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(MIGRATIONS)
  active.push(instance)
  return instance.database
}

describe("the account's agent settings in D1", () => {
  test("an account that never visited Settings has agents off", async () => {
    const settings = d1AgentSettings(await database())
    expect(await settings.read("user-a")).toEqual({ crossMachineWrites: false })
  })

  test("a write is read back, and only for the account that made it", async () => {
    const target = await database()
    let clock = 5_000
    const settings = d1AgentSettings(target, { now: () => clock })

    expect(await settings.write("user-a", { crossMachineWrites: true })).toEqual({ crossMachineWrites: true })
    expect(await settings.read("user-a")).toEqual({ crossMachineWrites: true })
    expect(await settings.read("user-b")).toEqual({ crossMachineWrites: false })

    clock = 6_000
    await settings.write("user-a", { crossMachineWrites: false })
    expect(await settings.read("user-a")).toEqual({ crossMachineWrites: false })
    const row = await target
      .prepare("select cross_machine_writes, updated_at from user_agent_settings where user_id = ?")
      .bind("user-a")
      .first<{ cross_machine_writes: number; updated_at: number }>()
    expect(row).toEqual({ cross_machine_writes: 0, updated_at: 6_000 })
  })

  test("the cross-machine reader follows the stored row and ignores the organization", async () => {
    const target = await database()
    const reader = d1CrossMachineWrites(target)
    expect(await reader({ userId: "user-a", orgId: "org-1" })).toBe(false)

    await d1AgentSettings(target).write("user-a", { crossMachineWrites: true })
    expect(await reader({ userId: "user-a", orgId: "org-1" })).toBe(true)
    expect(await reader({ userId: "user-a", orgId: "org-2" })).toBe(true)
    expect(await reader({ userId: "user-b", orgId: "org-1" })).toBe(false)
  })

  test("a cloud root's Tasks grant carries start exactly when the owner's row says so", async () => {
    const target = await database()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const signingEnv = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
    const mint = createTasksRootCapability({ signingEnv, crossMachineWrites: d1CrossMachineWrites(target) })
    const root = { userId: "user-a", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" }

    expect((await mint(root)).WORKSPACE_RUNTIME_TASKS_OPERATIONS).toBe("read,create")
    await d1AgentSettings(target).write("user-a", { crossMachineWrites: true })
    expect((await mint(root)).WORKSPACE_RUNTIME_TASKS_OPERATIONS).toBe("read,create,start")
    await d1AgentSettings(target).write("user-a", { crossMachineWrites: false })
    expect((await mint(root)).WORKSPACE_RUNTIME_TASKS_OPERATIONS).toBe("read,create")
  })
})
