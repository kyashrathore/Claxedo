import { afterEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

afterEach(() => {
  delete process.env.CLAXEDO_DATA_DIR
})

test("two people on one desktop: each connection spends its own owner's or the org's secret, and only the machine owner falls back to the machine login", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "connection-scope-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { putCredential, credentialById } = await import("@claxedo/server-core/credentials/registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  const { adoptHostEnrolledOwner, resetHostEnrolledOwner } = await import("@claxedo/host-serving/serving")
  const { localConnectionSecretScope } = await import("./connection-secret-scope")
  setBackendOverride(createTestBackend())
  try {
    const row = async (write: { owner: string | null }, secret: string) => credentialById((await putCredential({
      ...write, provider_id: `connection:${secret}`, kind: "api_key", source: "managed", secret,
    })).id, { onOutage: "throw" })!
    const operator = await row({ owner: "local" }, "machine-owner-key")
    const member = await row({ owner: "usr_member" }, "member-key")
    const org = await row({ owner: null }, "org-key")

    const machine = localConnectionSecretScope({ kind: "machine-owner" })
    expect([operator, member, org].map(machine.admits)).toEqual([true, false, true])
    expect(machine.machineLoginAllowed).toBe(true)

    const other = localConnectionSecretScope({ kind: "person", userId: "usr_member" })
    expect([operator, member, org].map(other.admits)).toEqual([false, true, true])
    expect(other.machineLoginAllowed).toBe(false)

    await adoptHostEnrolledOwner("usr_machine_owner", { forget: () => () => {}, reapply: async () => {} })
    const relayedOwner = localConnectionSecretScope({ kind: "person", userId: "usr_machine_owner" })
    expect([operator, member, org].map(relayedOwner.admits)).toEqual([true, false, true])
    expect(relayedOwner.machineLoginAllowed).toBe(true)
    expect([operator, member, org].map(localConnectionSecretScope({ kind: "person", userId: "local" }).admits))
      .toEqual([false, false, true])
  } finally {
    resetHostEnrolledOwner()
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
