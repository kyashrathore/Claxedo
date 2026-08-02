import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { sandboxDriverRoutes } from "./sandbox-driver-routes"
import type { ControlPlaneCredentials } from "../../../authority/services"

// Sandbox driver secrets have exactly one sink: the credential registry.
//
// This route used to swallow a failed `putCredential` and write the raw auth
// map into user-agent-config.json instead — plaintext, mode 0644 — and then
// still return `configured: true`, so the settings UI reported success while
// the secret sat on disk in the clear. These tests pin the corrected behavior:
// a store failure is surfaced, and nothing about the secret is persisted.

const SECRET = "dt_contract_test_secret_value"

let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-driver-secrets-"))
  process.env.CLAXEDO_DATA_DIR = tempDataDir
})

afterEach(() => {
  fs.rmSync(path.join(tempDataDir, "user-agent-config.json"), { force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

function credentialsThatFailToStore(): ControlPlaneCredentials {
  return {
    listCredentials: async () => [],
    putCredential: async () => {
      throw new Error("secret backend unavailable")
    },
    deleteCredentialsByProvider: async () => 0,
  } as unknown as ControlPlaneCredentials
}

/**
 * Saving a key now probes the provider first, so without a stub these storage
 * and codec tests would make real network calls with fake keys — slow, flaky,
 * and answered with the 401 that now (correctly) refuses the save. Verification
 * itself is covered in sandbox-driver-verify.test.ts; here it is held constant
 * at "the provider accepted it" so the subject stays storage.
 */
const ACCEPTED = (async () =>
  ({ ok: true, status: 200, text: async () => "", body: undefined }) as unknown as Response) as unknown as typeof fetch

function appWith(credentials: ControlPlaneCredentials) {
  return new Hono().route("/api/workspace", sandboxDriverRoutes(undefined, { credentials, fetch: ACCEPTED }))
}

function writtenConfig() {
  const file = path.join(tempDataDir, "user-agent-config.json")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}

async function putDaytonaAuth(app: Hono) {
  return app.request("/api/workspace/drivers/daytona/auth", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth: { api_key: SECRET }, default: true }),
  })
}

describe("sandbox driver credential storage", () => {
  test("a failed credential-store write is surfaced instead of silently downgraded", async () => {
    const response = await putDaytonaAuth(appWith(credentialsThatFailToStore()))

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { code: "sandbox_driver_credential_store_failed" },
    })
  })

  test("a failed credential-store write never persists the secret in plaintext", async () => {
    await putDaytonaAuth(appWith(credentialsThatFailToStore()))

    // The whole point: no plaintext copy anywhere on disk, and no partially
    // applied config write (the default_driver flip must not land either).
    expect(writtenConfig()).not.toContain(SECRET)
    expect(writtenConfig()).toBe("")
  })

  test("a successful write reports the driver configured without storing the secret in config", async () => {
    const stored: { provider_id: string; kind: string; secret: string }[] = []
    const credentials = {
      listCredentials: async () =>
        stored.map((item) => ({ provider_id: item.provider_id, status: "available" })),
      putCredential: async (input: { provider_id: string; kind: string; secret: string }) => {
        stored.push(input)
        return input
      },
      deleteCredentialsByProvider: async () => 0,
    } as unknown as ControlPlaneCredentials

    const response = await putDaytonaAuth(appWith(credentials))

    expect(response.status).toBe(200)
    expect(stored).toMatchObject([{ provider_id: "daytona", kind: "sandbox_driver" }])
    // The codec JSON-wraps every driver uniformly (see the round-trip suite);
    // the secret is the encoded form, not the bare field value.
    expect(stored[0]!.secret).toBe(JSON.stringify({ api_key: SECRET }))

    const body = (await response.json()) as { drivers: { id: string; configured: boolean }[] }
    expect(body.drivers.find((item) => item.id === "daytona")?.configured).toBe(true)

    // The secret reached the registry, not the config file.
    expect(writtenConfig()).not.toContain(SECRET)
  })
})

// Encoder (`sandboxDriverManagedSecret`) and decoder (`parseManagedAuth`) live
// in different files and drifted apart unnoticed: both special-cased drivers,
// but not the same ones, so exe.dev and Box decoded to the literal string
// `{"api_token":"…"}`. The save succeeded and the tile showed configured — only
// the sandbox launch ever saw the corrupt token. This drives real writes
// through the real route into the real registry and reads them back exactly the
// way the launcher does, so the two halves cannot silently disagree again.
describe("sandbox driver credential codec round trip", () => {
  const CASES: { id: string; auth: Record<string, string> }[] = [
    { id: "exe", auth: { api_token: "tok_exe_123" } },
    { id: "daytona", auth: { api_key: "dt_key_123" } },
    { id: "box", auth: { api_key: "box_key_123" } },
    { id: "docker", auth: { image: "ghcr.io/example/runtime:test" } },
    { id: "modal", auth: { token_id: "mid_123", token_secret: "msec_123" } },
    { id: "vercel", auth: { access_token: "vt_123", team_id: "team_123", project_id: "proj_123" } },
    { id: "cloudflare", auth: { api_token: "cf_123", worker_url: "https://worker.test" } },
  ]

  test.each(CASES)("$id survives write → store → launch-time read", async ({ id, auth }) => {
    const app = new Hono().route("/api/workspace", sandboxDriverRoutes(undefined, { fetch: ACCEPTED }))
    const { sandboxDriverAuthManaged } = await import("../driver-auth")

    const response = await app.request(`/api/workspace/drivers/${id}/auth`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth }),
    })
    expect(response.status).toBe(200)

    // `sandboxDriverAuthManaged` is what the sandbox launcher calls.
    await expect(sandboxDriverAuthManaged(id as never)).resolves.toEqual(auth)
  })
})

// `provider_id` is shared with model providers and is NOT unique — `vercel` is
// both a sandbox driver id and a model-provider id. Removing sandbox
// credentials used to delete EVERY row for the id, destroying the user's model
// API key as a side effect of a settings click they'd read as narrow.
describe("sandbox driver credential removal is scoped to its own kind", () => {
  test("Remove deletes the sandbox credential and spares the model provider key", async () => {
    const registry = await import("../../credentials/registry")

    await registry.putCredential({
      provider_id: "vercel",
      kind: "api_key",
      source: "managed",
      label: "Vercel model provider",
      secret: "model-provider-key",
    })
    await registry.putCredential({
      provider_id: "vercel",
      kind: "sandbox_driver",
      source: "managed",
      label: "Sandbox driver vercel",
      secret: JSON.stringify({ access_token: "a", team_id: "b", project_id: "c" }),
    })

    const app = new Hono().route("/api/workspace", sandboxDriverRoutes())
    const response = await app.request("/api/workspace/drivers/vercel/auth", { method: "DELETE" })
    expect(response.status).toBe(200)

    const remaining = (await registry.listCredentials()).filter((item) => item.provider_id === "vercel")
    expect(remaining.map((item) => item.kind)).toEqual(["api_key"])
  })

  test("a sandbox lookup never resolves a model provider credential", async () => {
    const registry = await import("../../credentials/registry")

    // A dedicated id: the round-trip suite above writes a sandbox_driver row
    // for every real driver into this same temp registry, so asserting the
    // ABSENCE of one has to use an id no other test touches. The scoping
    // behaviour is id-agnostic; the sibling test covers the real `vercel`
    // collision end-to-end through the route.
    const providerId = "kind-scope-probe"
    await registry.putCredential({
      provider_id: providerId,
      kind: "api_key",
      source: "managed",
      label: "Model provider only",
      secret: "model-only-key",
    })

    // The model key must not stand in for a sandbox credential, or
    // `workspace.ts`'s create gate passes and the launch fails later instead.
    expect(registry.getCredentialByProvider(providerId, "sandbox_driver")).toBeUndefined()
    expect(await registry.resolveSecret(providerId, "sandbox_driver")).toBeNull()
    // Unscoped still sees it, so model-provider callers are unaffected.
    expect(registry.getCredentialByProvider(providerId)?.kind).toBe("api_key")
  })
})
