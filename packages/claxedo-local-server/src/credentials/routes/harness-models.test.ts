import { afterEach, beforeEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { claudeBundledOptions } from "@claxedo/harness/claude-models"
import { codexBundledOptions } from "@claxedo/harness/codex-models"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-models-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  setBackendOverride(createTestBackend())
})

afterEach(async () => {
  const { setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  setBackendOverride(undefined)
  ClaxedoDB.close()
  delete process.env.CLAXEDO_DATA_DIR
  await fs.rm(root, { recursive: true, force: true })
})

const cursorModels = (async (_url: string, init?: RequestInit) => {
  const token = new Headers(init?.headers).get("authorization")
  if (token === "Bearer cursor-refused") return new Response("{}", { status: 401 })
  return Response.json({ items: [{ id: "composer-2.5", displayName: "Composer 2.5" }] })
}) as unknown as typeof fetch

async function daemon() {
  const { putCredential } = await import("@claxedo/server-core/credentials/registry")
  const { localControlPlaneCredentials } = await import("../machine-credentials")
  const { CredentialRoutes } = await import("@claxedo/server-core/credentials/routes/credential")
  const machineLogins = vi.fn(async () => [])
  const store = { ...localControlPlaneCredentials(), machineLogins }
  const app = CredentialRoutes(store, { fetch: cursorModels })
  const read = async (harness: string) => {
    const response = await app.request(`http://localhost/harness-models?nativeHarness=${harness}`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const putAccount = (provider_id: string, secret: string, kind: "api_key" | "oauth_token" = "api_key", owner: string | null = "local") =>
    putCredential({ owner, provider_id, kind, source: "managed", secret }, "__local__")
  return { app, read, put: putAccount, machineLogins, store }
}

test("Claude Code with no stored account lists its plan form for this computer's login, and asks no CLI", async () => {
  const { read, machineLogins } = await daemon()
  expect(await read("claude")).toEqual({ status: 200, body: claudeBundledOptions("plan") })
  expect(machineLogins).not.toHaveBeenCalled()
})

test("Claude Code lists the API form for a stored key and the plan form for a stored subscription token", async () => {
  const { read, put } = await daemon()
  await put("anthropic", "sk-ant-api03-local")
  expect(await read("claude")).toEqual({ status: 200, body: claudeBundledOptions("api") })
  await put("claude-sdk", "sk-ant-oat01-local", "oauth_token")
  expect(await read("claude")).toEqual({ status: 200, body: claudeBundledOptions("plan") })
})

test("Codex lists its bundled models", async () => {
  const { read } = await daemon()
  expect(await read("codex")).toEqual({ status: 200, body: codexBundledOptions() })
})

test("Cursor lists the stored key's models from Cursor, names Cursor's refusal, and refuses with no stored key", async () => {
  const { read, put } = await daemon()
  expect(await read("cursor")).toMatchObject({ status: 409, body: { error: { code: "cursor_account_missing" } } })
  const key = await put("cursor-sdk", "cursor-good")
  const listed = await read("cursor")
  expect(listed.status).toBe(200)
  const choices = (listed.body.options as { category?: string; selectOptions?: { id: string }[] }[]).find((option) => option.category === "model")?.selectOptions
  expect(choices?.map((row) => row.id)).toEqual(["auto", "composer-2.5"])
  const { deleteCredential } = await import("@claxedo/server-core/credentials/registry")
  await deleteCredential(key.id, "__local__")
  await put("cursor-sdk", "cursor-refused")
  expect(await read("cursor")).toEqual({ status: 502, body: { error: { code: "cursor_models_unavailable", message: "Cursor refused the model list read (401)." } } })
})

test("a harness set to the organization's account, which holds none, is refused with the organization's reason", async () => {
  const { app, read, put } = await daemon()
  await put("anthropic", "sk-ant-api03-local")
  expect((await app.request("http://localhost/account-sources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider_ids: ["claude-sdk", "claude-acp", "anthropic"], source: "org" }) })).status).toBe(409)
  await put("anthropic", "sk-ant-api03-org", "api_key", null)
  expect((await app.request("http://localhost/account-sources", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider_ids: ["claude-sdk", "claude-acp", "anthropic"], source: "org" }) })).status).toBe(200)
  expect(await read("claude")).toEqual({ status: 200, body: claudeBundledOptions("api") })
  const { listCredentials, deleteCredential } = await import("@claxedo/server-core/credentials/registry")
  for (const row of listCredentials("__local__").filter((row) => row.owner === null)) await deleteCredential(row.id, "__local__")
  expect(await read("claude")).toMatchObject({ status: 409, body: { error: { code: "account_unavailable", details: { reason: "org_account_unavailable" } } } })
})

test("a harness the table does not name is refused", async () => {
  const { read } = await daemon()
  expect(await read("pi")).toMatchObject({ status: 400, body: { error: { code: "harness_models_unsupported" } } })
})
