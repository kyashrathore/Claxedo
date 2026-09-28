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

describe("the supervisor hears the delivered set change", () => {
  const reconciled = vi.fn(async () => {})
  const port = defaultControlPlaneCredentials()

  beforeEach(async () => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.delete(ClaxedoProviderCredentialTable).run())
    synced.mockClear()
    reconciled.mockClear()
    const { configureWorkspaceSupervisorPort } = await import("../workspace/supervisor-port")
    configureWorkspaceSupervisorPort({
      hold() {},
      release() {},
      markUse() {},
      touch() {},
      broadcastRuntimeConfig: async () => {},
      reconcileCredentialDelivery: reconciled,
    })
  })

  afterAll(async () => {
    const { configureWorkspaceSupervisorPort } = await import("../workspace/supervisor-port")
    configureWorkspaceSupervisorPort(undefined)
  })

  test("a revocation runs the delivery reconcile", async () => {
    const claude = await port.putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "key_a",
    })
    reconciled.mockClear()

    await port.updateCredentialStatus(claude.id, "revoked")

    expect(reconciled).toHaveBeenCalledOnce()
  })

  test("an account switch and a removal run it", async () => {
    const claude = await port.putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "key_a",
    })
    const cursor = await port.putCredential({ owner: "local",
      provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor",
    })
    reconciled.mockClear()

    await port.setActiveCredentials!([claude.id], undefined, "local")
    await port.deleteCredential(cursor.id)

    expect(reconciled).toHaveBeenCalledTimes(2)
  })

  test("a write that changed nothing — a delete of a missing row — does not sweep", async () => {
    await port.deleteCredential("missing-id")

    expect(reconciled).not.toHaveBeenCalled()
  })

  test("a sandbox that cannot reconcile still lets local runtimes take the change, and the write reports it", async () => {
    const local = defaultControlPlaneCredentials({ refreshLocalRuntimes: synced })
    reconciled.mockRejectedValueOnce(new Error("sandbox driver is down"))

    await expect(local.putCredential({ owner: "local", provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "key_a" }))
      .rejects.toMatchObject({ name: "CredentialDeliveryError", cause: expect.objectContaining({ message: "sandbox driver is down" }) })
    expect(synced).toHaveBeenCalledOnce()
  })

  test("a composition without a supervisor reconciles nothing and does not fail the write", async () => {
    const { configureWorkspaceSupervisorPort } = await import("../workspace/supervisor-port")
    configureWorkspaceSupervisorPort(undefined)

    const claude = await port.putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "key_a",
    })

    await expect(port.updateCredentialStatus(claude.id, "revoked")).resolves.toBeUndefined()
  })
})
