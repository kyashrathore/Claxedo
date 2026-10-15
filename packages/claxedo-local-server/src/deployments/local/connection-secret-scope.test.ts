import { afterEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

afterEach(() => {
  delete process.env.CLAXEDO_DATA_DIR
})

test("two people on one desktop: each connection spends only its own owner's stored key, never the org's, a model account or a sandbox key, and only the machine owner falls back to the machine login", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-scope-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { putCredential, credentialById } = await import("@claxedo/server-core/credentials/registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  const { adoptHostEnrolledOwner, resetHostEnrolledOwner } = await import("@claxedo/host-serving/serving")
  const { localConnectionSecretScope } = await import("./connection-secret-scope")
  setBackendOverride(createTestBackend())
  try {
    const row = async (write: { owner: string | null; provider_id?: string; kind?: "api_key" | "sandbox_driver" }, secret: string) => credentialById((await putCredential({
      provider_id: `connection:${secret}`, kind: "api_key", ...write, source: "managed", secret,
    })).id, { onOutage: "throw" })!
    const operator = await row({ owner: "local" }, "machine-owner-key")
    const member = await row({ owner: "usr_member" }, "member-key")
    const org = await row({ owner: null }, "org-key")
    const account = await row({ owner: "local", provider_id: "anthropic" }, "sk-ant-api03-operator")
    const sandboxKey = await row({ owner: "local", provider_id: "modal", kind: "sandbox_driver" }, JSON.stringify({ token_id: "a", token_secret: "b" }))

    const machine = localConnectionSecretScope({ kind: "machine-owner" })
    expect([operator, member, org, account, sandboxKey].map(machine.admits)).toEqual([true, false, false, false, false])
    expect(machine.machineLoginAllowed).toBe(true)

    const other = localConnectionSecretScope({ kind: "person", userId: "usr_member" })
    expect([operator, member, org].map(other.admits)).toEqual([false, true, false])
    expect(other.machineLoginAllowed).toBe(false)

    await adoptHostEnrolledOwner("usr_machine_owner", { forget: () => () => {}, reapply: async () => {} })
    const relayedOwner = localConnectionSecretScope({ kind: "person", userId: "usr_machine_owner" })
    expect([operator, member, org].map(relayedOwner.admits)).toEqual([true, false, false])
    expect(relayedOwner.machineLoginAllowed).toBe(true)
    expect([operator, member, org].map(localConnectionSecretScope({ kind: "person", userId: "local" }).admits))
      .toEqual([false, false, false])
  } finally {
    resetHostEnrolledOwner()
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
