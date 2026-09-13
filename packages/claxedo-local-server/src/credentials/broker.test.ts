import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = path.join(realpathSync(os.tmpdir()), `local-broker-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const {
  deleteCredential,
  getCredential,
  putCredential,
  setActiveCredentials,
  updateCredentialHealth,
  updateCredentialSecret,
} = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { createLocalCredentialBroker } = await import("./broker")

type Projection = Awaited<ReturnType<ReturnType<typeof createLocalCredentialBroker>["projectAuth"]>>[string]

/** The bound half of a projection; a test that asks for one must not get "unavailable". */
function bound(projection: Projection | undefined) {
  if (!projection) throw new Error("expected a projection")
  if ("unavailable" in projection) throw new Error(`expected a bound projection, got ${projection.reason}`)
  return projection
}

const workspaceId = "ws-broker"
const brokerOrigin = "http://127.0.0.1:2595"

async function activeRow(secret: string, providerId = "claude-sdk", kind: "api_key" | "oauth_token" = "api_key") {
  const credential = await putCredential({
    provider_id: providerId,
    kind,
    source: "managed",
    account_id: `acc-${randomUUID().slice(0, 8)}`,
    secret,
  })
  expect(setActiveCredentials([credential.id])).toMatchObject({ ok: true })
  return credential
}


function broker(dataDir = root) {
  return createLocalCredentialBroker({ dataDir, brokerOrigin })
}

/** The binding id the projection published, read back out of its base URL. */
function bindingIdOf(baseUrl: string) {
  return baseUrl.slice(`${brokerOrigin}/bindings/`.length)
}

beforeEach(() => {
  setBackendOverride(createTestBackend())
})

afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

describe("local binding authority", () => {
  test("mints a signing key and a newer lease generation on each boot", () => {
    const dataDir = path.join(root, `boot-${randomUUID().slice(0, 8)}`)
    const first = broker(dataDir)
    const second = broker(dataDir)

    const keyFile = path.join(dataDir, "credentials", "broker.key")
    expect(readFileSync(keyFile).byteLength).toBe(32)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(second.runtimeIdentity(workspaceId).leaseGeneration)
      .toBe(first.runtimeIdentity(workspaceId).leaseGeneration + 1)
    expect(second.runtimeIdentity(workspaceId)).toMatchObject({
      userId: "operator",
      leaseId: `local:${workspaceId}`,
      runtimeId: `embedded:${workspaceId}`,
    })
  })

  test("resolve derives the binding for an active row and returns its current secret", async () => {
    const credential = await activeRow("sk-ant-api03-first")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["claude-sdk"])

    expect(projection).toMatchObject({ authMode: "api-key", apiPath: "/v1" })
    expect(projection.baseUrl.startsWith(`${brokerOrigin}/bindings/`)).toBe(true)
    const resolved = await local.authority.resolve(bindingIdOf(projection.baseUrl))
    expect(resolved?.value).toBe("sk-ant-api03-first")
    expect(resolved?.binding).toMatchObject({
      credentialId: credential.id,
      status: "active",
      revision: getCredential(credential.id)!.updated_at,
      destination: { origin: "https://api.anthropic.com", methods: ["POST", "GET"], pathPrefixes: ["/v1/"] },
      injection: { header: "x-api-key" },
    })
    expect(await local.authority.currentRuntime(local.runtimeIdentity(workspaceId))).toBe(true)
  })

  test("a subscription token binds as a bearer, a key as x-api-key", async () => {
    await activeRow("sk-ant-oat01-subscription", "anthropic")
    const local = broker()
    const rows = await local.projectAuth({ workspaceId })

    expect(rows.anthropic).toMatchObject({ authMode: "bearer" })
    const resolved = await local.authority.resolve(bindingIdOf(bound(rows.anthropic).baseUrl))
    expect(resolved?.binding.injection).toEqual({ header: "Authorization", scheme: "Bearer" })
  })

  test("a rotated secret is served on the next resolve with no other call", async () => {
    const credential = await activeRow("sk-ant-api03-before")
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)
    expect((await local.authority.resolve(id))?.value).toBe("sk-ant-api03-before")

    await updateCredentialSecret(credential.id, "sk-ant-api03-after")

    expect((await local.authority.resolve(id))?.value).toBe("sk-ant-api03-after")
  })

  test("a withdrawn row stops resolving, whether it failed auth or was deleted", async () => {
    const failing = await activeRow("sk-ant-api03-failing")
    const local = broker()
    const failingId = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)
    expect(await local.authority.resolve(failingId)).toBeDefined()
    updateCredentialHealth(failing.id, "auth_failed", Date.now())
    expect(await local.authority.resolve(failingId)).toBeUndefined()

    const deleted = await activeRow("sk-ant-api03-deleted")
    const deletedId = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)
    expect(await local.authority.resolve(deletedId)).toBeDefined()
    await deleteCredential(deleted.id)
    expect(await local.authority.resolve(deletedId)).toBeUndefined()
  })

  test("a runtime this process never projected for is not current and resolves nothing", async () => {
    await activeRow("sk-ant-api03-unprojected")
    const projecting = broker()
    const id = bindingIdOf(bound((await projecting.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    const other = broker()
    expect(await other.authority.resolve(id)).toBeUndefined()
    expect(await other.authority.currentRuntime(projecting.runtimeIdentity(workspaceId))).toBe(false)
  })

  test("a provider with no destination policy gets no binding at all", async () => {
    await activeRow("gsk-some-key", "groq")
    const local = broker()

    expect(await local.projectAuth({ workspaceId })).not.toHaveProperty("groq")
  })

  test("an OpenAI API key binds to the API host, a ChatGPT login to the Codex backend", async () => {
    await activeRow("sk-proj-openai-key", "openai")
    const local = broker()
    const key = bound((await local.projectAuth({ workspaceId })).openai)

    expect(key).toMatchObject({ authMode: "bearer", apiPath: "/v1" })
    expect((await local.authority.resolve(bindingIdOf(key.baseUrl)))?.binding).toMatchObject({
      destination: { origin: "https://api.openai.com", methods: ["POST", "GET"], pathPrefixes: ["/v1/"] },
      injection: { header: "Authorization", scheme: "Bearer" },
    })

    await activeRow(
      JSON.stringify({ tokens: { access_token: "chatgpt-access", account_id: "acct-7" } }),
      "codex-app-server",
      "oauth_token",
    )
    const subscription = bound((await local.projectAuth({ workspaceId }))["codex-app-server"])

    expect(subscription).toMatchObject({ authMode: "bearer", apiPath: "/backend-api/codex" })
    const resolved = await local.authority.resolve(bindingIdOf(subscription.baseUrl))
    expect(resolved?.value).toBe("chatgpt-access")
    expect(resolved?.binding).toMatchObject({
      destination: {
        origin: "https://chatgpt.com",
        methods: ["POST", "GET"],
        pathPrefixes: ["/backend-api/codex/"],
      },
      injection: { header: "Authorization", scheme: "Bearer", headers: { "ChatGPT-Account-Id": "acct-7" } },
    })
  })

  test("a Cursor key binds to the backend the SDK targets", async () => {
    await activeRow("key_cursor", "cursor-sdk")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["cursor-sdk"])

    expect(projection).toMatchObject({ authMode: "bearer" })
    expect(projection.apiPath).toBeUndefined()
    expect((await local.authority.resolve(bindingIdOf(projection.baseUrl)))?.binding).toMatchObject({
      destination: { origin: "https://api2.cursor.sh" },
      injection: { header: "Authorization", scheme: "Bearer" },
    })
  })

  test("an active row the provider rejected projects unavailable rather than nothing", async () => {
    const credential = await activeRow("sk-ant-api03-rejected")
    const local = broker()
    expect(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl).toContain("/bindings/")

    updateCredentialHealth(credential.id, "auth_failed", Date.now())

    expect((await local.projectAuth({ workspaceId }))["claude-sdk"])
      .toEqual({ unavailable: true, reason: "auth_failed" })
  })

  test("a deleted row falls back to the implicit tier, an expired one does not", async () => {
    const expiring = await activeRow("sk-ant-api03-expiring")
    const local = broker()
    updateCredentialHealth(expiring.id, "expired", Date.now())

    expect((await local.projectAuth({ workspaceId }))["claude-sdk"])
      .toEqual({ unavailable: true, reason: "expired" })

    await deleteCredential(expiring.id)

    expect(await local.projectAuth({ workspaceId })).not.toHaveProperty("claude-sdk")
  })

  test("reportFailure marks the row only for the revision the request used", async () => {
    const credential = await activeRow("sk-ant-api03-reported")
    const local = broker()
    const failure = { bindingId: "unused", credentialId: credential.id, status: 401 }

    await local.authority.reportFailure({ ...failure, revision: getCredential(credential.id)!.updated_at - 1 })
    expect(getCredential(credential.id)?.health).not.toBe("auth_failed")

    await local.authority.reportFailure({ ...failure, revision: getCredential(credential.id)!.updated_at })
    expect(getCredential(credential.id)?.health).toBe("auth_failed")
    expect(getCredential(credential.id)?.status).toBe("error")
  })

  test("a vendor 403 does not withdraw a working credential", async () => {
    const credential = await activeRow("sk-ant-api03-forbidden")
    const local = broker()

    await local.authority.reportFailure({
      bindingId: "unused",
      credentialId: credential.id,
      revision: getCredential(credential.id)!.updated_at,
      status: 403,
    })

    expect(getCredential(credential.id)?.health).not.toBe("auth_failed")
  })
})
