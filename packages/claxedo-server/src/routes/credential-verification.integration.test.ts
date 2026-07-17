import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, test, vi } from "vitest"

const root = path.join(realpathSync(os.tmpdir()), `credential-verification-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../credentials/store")
const { putCredential } = await import("../credentials/registry")
const { defaultControlPlaneCredentials } = await import("../control-plane/services")
const { CredentialRoutes } = await import("./credential")
const { ClaxedoDB } = await import("../storage/db")

describe("credential verification integration", () => {
  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = previous
  })

  test("persists the route result and returns that same redacted health from listing", async () => {
    setBackendOverride(createTestBackend())
    const credential = await putCredential({
      provider_id: "openai",
      kind: "api_key",
      source: "managed",
      secret: "sk-integration-secret",
    })
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "response_1" }))
    const app = CredentialRoutes(defaultControlPlaneCredentials(), {
      fetch: request as unknown as typeof fetch,
      now: () => 2_000,
    })

    const verified = await app.request(`http://localhost/${credential.id}/verify`, { method: "POST" })
    const listed = await app.request("http://localhost/")
    const verifiedBody = await verified.json()
    const listedBody = await listed.json() as { credentials: Array<Record<string, unknown>> }

    expect(verifiedBody).toEqual({ result: "ok", health: "ok", verified_at: 2_000 })
    expect(listedBody.credentials.find((item) => item.id === credential.id)).toMatchObject({
      health: "ok",
      status: "available",
      last_validated_at: 2_000,
      has_secret: true,
    })
    expect(JSON.stringify({ verifiedBody, listedBody })).not.toContain("sk-integration-secret")
    expect(JSON.stringify({ verifiedBody, listedBody })).not.toContain(credential.secure_ref)
  })
})
