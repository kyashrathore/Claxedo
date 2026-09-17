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

const synced = vi.fn(async (_org?: string, _providers?: readonly string[]) => ({ bound: [], removed: [] }))
vi.mock("@claxedo/server-core/opencode/sdk-credential-bridge", () => ({
  syncCredentialsToSdk: (org?: string, providers?: readonly string[]) => synced(org, providers),
}))

const { createTestBackend, setBackendOverride } = await import("../credentials/backend-registry")
const { ClaxedoProviderCredentialTable } = await import("../credentials/provider-credential.sql")
const { ClaxedoDB } = await import("../platform/db")
const { defaultControlPlaneCredentials } = await import("./default-credentials")
ClaxedoDB.Drizzle()

describe("the engine hears about the providers a mutation touched", () => {
  const port = defaultControlPlaneCredentials()

  beforeEach(() => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.delete(ClaxedoProviderCredentialTable).run())
    synced.mockClear()
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("a stored key names its own provider", async () => {
    await port.putCredential({ provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor" })

    expect(synced).toHaveBeenCalledTimes(1)
    expect(synced.mock.calls[0]?.[1]).toEqual(["cursor-sdk"])
  })

  test("a switch names every provider whose mark moved", async () => {
    const claude = await port.putCredential({
      provider_id: "claude-sdk", kind: "oauth_token", source: "managed", account_id: "acc_a", secret: "tok_a",
    })
    const cursor = await port.putCredential({
      provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor",
    })
    synced.mockClear()

    const result = await port.setActiveCredentials!([claude.id, cursor.id])

    expect(result.ok).toBe(true)
    expect(synced.mock.calls[0]?.[1]).toEqual(["claude-sdk", "cursor-sdk"])
  })

  test("a removed row names the provider it belonged to", async () => {
    const cursor = await port.putCredential({ provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_cursor" })
    synced.mockClear()

    await port.deleteCredential(cursor.id)
    await port.deleteCredentialsByProvider("openai")
    await port.deleteCredentialsByProvider("claude-sdk")

    expect(synced.mock.calls.map((call) => call[1])).toEqual([["cursor-sdk"]])
  })

  test("a renewed token names the row's provider", async () => {
    const claude = await port.putCredential({
      provider_id: "claude-sdk", kind: "oauth_token", source: "managed", account_id: "acc_a", secret: "tok_a",
    })
    synced.mockClear()

    await port.updateCredentialSecret!(claude.id, "tok_b")

    expect(synced.mock.calls[0]?.[1]).toEqual(["claude-sdk"])
  })
})
