import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `default-credentials-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const synced = vi.fn(async () => {})

const { createTestBackend, setBackendOverride } = await import("../credentials/backend-registry")
const { ClaxedoProviderCredentialTable } = await import("../credentials/provider-credential.sql")
const { ClaxedoDB } = await import("../platform/db")
const { defaultControlPlaneCredentials } = await import("./default-credentials")
ClaxedoDB.Drizzle()

// File scope, not the first describe's: every describe below opens this same
// database, and restoring the variable by assignment would store the string
// "undefined" — which resolves to ./undefined/ under the package cwd.
afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev
})

describe("running workspaces receive credential mutations", () => {
  const port = defaultControlPlaneCredentials({ refreshLocalRuntimes: synced })

  beforeEach(() => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.delete(ClaxedoProviderCredentialTable).run())
    synced.mockClear()
  })

  test("a stored key reaches running workspaces", async () => {
    await port.putCredential({ owner: "local", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor" })

    expect(synced).toHaveBeenCalledTimes(1)
  })

  test("an account switch reaches running workspaces once", async () => {
    const claude = await port.putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "oauth_token", source: "managed", account_id: "acc_a", secret: "tok_a",
    })
    const cursor = await port.putCredential({ owner: "local",
      provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor",
    })
    synced.mockClear()

    const result = await port.setActiveCredentials!([claude.id, cursor.id], undefined, "local")

    expect(result.ok).toBe(true)
    expect(synced).toHaveBeenCalledTimes(1)
  })

  test("only a removal that removed a row reaches running workspaces", async () => {
    const cursor = await port.putCredential({ owner: "local", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor" })
    synced.mockClear()

    await port.deleteCredential(cursor.id)
    await port.deleteCredentialsByProvider("openai")
    await port.deleteCredentialsByProvider("claude-sdk")

    expect(synced).toHaveBeenCalledTimes(1)
  })

  test("a renewed token reaches running workspaces", async () => {
    const claude = await port.putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "oauth_token", source: "managed", account_id: "acc_a", secret: "tok_a",
    })
    synced.mockClear()

    await port.updateCredentialSecret!(claude.id, "tok_b")

    expect(synced).toHaveBeenCalledTimes(1)
  })
})

describe("a local runtime that cannot take the change", () => {
  test("makes the write report it", async () => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.delete(ClaxedoProviderCredentialTable).run())
    const port = defaultControlPlaneCredentials({ refreshLocalRuntimes: async () => { throw new Error("runtime is down") } })

    await expect(port.putCredential({ owner: "local", provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "key_a" }))
      .rejects.toMatchObject({ name: "CredentialDeliveryError", cause: expect.objectContaining({ message: "runtime is down" }) })
  })
})
