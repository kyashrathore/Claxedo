import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
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
  listCredentials,
  putCredential,
  setActiveCredentials,
  updateCredentialHealth,
  updateCredentialSecret,
  updateCredentialStatus,
} = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { createLocalCredentialBroker } = await import("./broker")
const { providerProjection } = await import("@claxedo/agent-sdk-runtime")

type Projection = Awaited<ReturnType<ReturnType<typeof createLocalCredentialBroker>["projectAuth"]>>[string]

/**
 * The bound half of a projection, read the way a runtime reads it. A test that
 * asks for one must not get "unavailable".
 */
function bound(projection: Projection | undefined) {
  if (!projection) throw new Error("expected a projection")
  const resolved = providerProjection(projection, {})
  if (!resolved) throw new Error("expected a valid projection")
  if ("unavailable" in resolved) throw new Error(`expected a bound projection, got ${resolved.reason}`)
  return resolved
}

const workspaceId = "ws-broker"
const brokerOrigin = "http://127.0.0.1:2595"
/** An `id_token` payload naming the account only in its claims. */
const CLAIMS = "eyJjaGF0Z3B0X2FjY291bnRfaWQiOiAiYWNjdC1mcm9tLWNsYWltcyJ9"

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

/** A registry whose table is gone for the length of one call: a real read failure. */
async function withRegistryOutage<T>(run: () => Promise<T>): Promise<T> {
  ClaxedoDB.raw().exec("ALTER TABLE `claxedo_provider_credential` RENAME TO `claxedo_provider_credential_hidden`")
  try {
    return await run()
  } finally {
    ClaxedoDB.raw().exec("ALTER TABLE `claxedo_provider_credential_hidden` RENAME TO `claxedo_provider_credential`")
  }
}

beforeEach(async () => {
  setBackendOverride(createTestBackend())
  // One store per test: a row left behind by an earlier test is an account this
  // one never chose, and the mark now moves between accounts on its own.
  for (const row of listCredentials()) await deleteCredential(row.id)
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
    const keyFile = path.join(dataDir, "credentials", "broker.key")
    const first = broker(dataDir)
    // Constructing the authority reads and writes nothing, so a data directory
    // it cannot open is not a boot failure.
    expect(existsSync(keyFile)).toBe(false)

    const generation = first.runtimeIdentity(workspaceId).leaseGeneration
    const second = broker(dataDir)

    expect(readFileSync(keyFile).byteLength).toBe(32)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(second.runtimeIdentity(workspaceId).leaseGeneration).toBe(generation + 1)
    expect(second.runtimeIdentity(workspaceId)).toMatchObject({
      userId: "operator",
      orgId: "__local__",
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
      revision: getCredential(credential.id)!.revision,
      destination: {
        origin: "https://api.anthropic.com",
        methods: ["POST", "GET"],
        pathPrefixes: ["/v1/messages", "/v1/models"],
      },
      injection: { header: "x-api-key" },
    })
    expect(await local.authority.currentRuntime(local.runtimeIdentity(workspaceId))).toBe(true)
  })

  test("a renewal re-projects onto the binding this broker already minted", async () => {
    // The renewal timer re-projects every workspace every 30s for the life of
    // the process. A binding id derived from anything that moves between
    // projections would strand one entry per tick in the map `resolve` reads,
    // and none of them is ever evicted.
    const credential = await activeRow("sk-ant-api03-renewed")
    const local = broker()
    const first = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)
    const second = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    expect(second).toBe(first)
    expect((await local.authority.resolve(first))?.binding.credentialId).toBe(credential.id)
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

  test("a provider with no destination policy is reported, never dropped", async () => {
    await activeRow("pplx-some-key", "perplexity")
    const local = broker()

    // Dropping it is indistinguishable from "no account chosen", which every
    // harness answers by running on the login its own machine holds.
    expect((await local.projectAuth({ workspaceId })).perplexity)
      .toEqual({ unavailable: true, reason: "no_destination" })
  })

  test("an account the operator revoked is reported as revoked and resolves nothing", async () => {
    const credential = await activeRow("sk-ant-api03-revoked")
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    updateCredentialStatus(credential.id, "revoked")

    expect((await local.projectAuth({ workspaceId }))["claude-sdk"])
      .toEqual({ unavailable: true, reason: "revoked" })
    expect(await local.authority.resolve(id)).toBeUndefined()
  })

  /**
   * The OpenCode engine and Pi both define providers for these four. Without a
   * row here the account the operator selected for one of them reaches neither
   * harness, and the turn runs on whatever login the machine holds.
   */
  test.each([
    ["openrouter", "https://openrouter.ai", "/api/v1", { header: "Authorization", scheme: "Bearer" }],
    ["google", "https://generativelanguage.googleapis.com", "/v1beta", { header: "x-goog-api-key" }],
    ["groq", "https://api.groq.com", "/openai/v1", { header: "Authorization", scheme: "Bearer" }],
    ["xai", "https://api.x.ai", "/v1", { header: "Authorization", scheme: "Bearer" }],
  ] as const)("%s binds to its own API root", async (providerId, origin, apiPath, injection) => {
    await activeRow(`key-${providerId}`, providerId)
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))[providerId])

    expect(projection.apiPath).toBe(apiPath)
    expect(projection.authMode).toBe(injection.header === "Authorization" ? "bearer" : "api-key")
    const resolved = await local.authority.resolve(bindingIdOf(projection.baseUrl))
    expect(resolved?.value).toBe(`key-${providerId}`)
    expect(resolved?.binding).toMatchObject({
      destination: { origin, methods: ["POST", "GET"], pathPrefixes: [`${apiPath}/`] },
      injection,
    })
  })

  test("a Gemini key travels in the header its own SDK sends, and reaches the vendor as the stored one", async () => {
    await activeRow("AIza-stored-gemini", "google")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId })).google)
    const realFetch = globalThis.fetch
    const upstream: Request[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstream.push(new Request(url, init))
      return new Response("{}")
    }) as typeof fetch
    try {
      const response = await local.handler(new Request(
        `${projection.baseUrl}/v1beta/models/gemini-3-pro:generateContent`,
        { method: "POST", headers: { "x-goog-api-key": projection.placeholder } },
      ))

      expect(response.status).toBe(200)
      expect(upstream[0]?.headers.get("x-goog-api-key")).toBe("AIza-stored-gemini")
      expect(projection.placeholder).not.toContain("AIza-stored-gemini")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("an OpenAI API key binds to the API host, a ChatGPT login to the Codex backend", async () => {
    await activeRow("sk-proj-openai-key", "openai")
    const local = broker()
    const key = bound((await local.projectAuth({ workspaceId })).openai)

    expect(key).toMatchObject({ authMode: "bearer", apiPath: "/v1" })
    expect((await local.authority.resolve(bindingIdOf(key.baseUrl)))?.binding).toMatchObject({
      destination: {
        origin: "https://api.openai.com",
        methods: ["POST", "GET"],
        pathPrefixes: ["/v1/responses", "/v1/chat/completions", "/v1/models"],
      },
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
        pathPrefixes: ["/backend-api/codex/responses", "/backend-api/codex/models"],
      },
      injection: { header: "Authorization", scheme: "Bearer", headers: { "ChatGPT-Account-Id": "acct-7" } },
    })
  })

  test("the agent's own account header never travels beside the operator's token", async () => {
    await activeRow(
      JSON.stringify({ tokens: { access_token: "chatgpt-access-no-account" } }),
      "codex-app-server",
      "oauth_token",
    )
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["codex-app-server"])
    const realFetch = globalThis.fetch
    const upstream: Request[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstream.push(new Request(url, init))
      return new Response("{}")
    }) as typeof fetch
    try {
      const response = await local.handler(new Request(`${projection.baseUrl}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${projection.placeholder}`,
          // The harness's own plan, alongside the operator's real token.
          "ChatGPT-Account-Id": "acct-belonging-to-the-agent",
        },
      }))

      expect(response.status).toBe(200)
      expect(upstream[0]?.headers.get("chatgpt-account-id")).toBeNull()
      expect(upstream[0]?.headers.get("authorization")).toBe("Bearer chatgpt-access-no-account")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a ChatGPT login that names its account only in its claims still binds one", async () => {
    await activeRow(
      JSON.stringify({ tokens: { access_token: "chatgpt-access-claims", id_token: `header.${CLAIMS}.sig` } }),
      "codex-app-server",
      "oauth_token",
    )
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["codex-app-server"])

    expect((await local.authority.resolve(bindingIdOf(projection.baseUrl)))?.binding.injection)
      .toEqual({ header: "Authorization", scheme: "Bearer", headers: { "ChatGPT-Account-Id": "acct-from-claims" } })
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

  test("a provider with no account left falls back to the implicit tier, an expired one does not", async () => {
    const expiring = await activeRow("sk-ant-api03-expiring")
    const local = broker()
    updateCredentialHealth(expiring.id, "expired", Date.now())

    expect((await local.projectAuth({ workspaceId }))["claude-sdk"])
      .toEqual({ unavailable: true, reason: "expired" })

    // Removing the marked row hands the mark to any account left, so the
    // implicit tier is what the provider falls to only once none remain.
    for (const row of listCredentials().filter((row) => row.provider_id === "claude-sdk")) {
      await deleteCredential(row.id)
    }

    expect(await local.projectAuth({ workspaceId })).not.toHaveProperty("claude-sdk")
  })

  test("one vendor refusal changes nothing; the second hands the mark on and the next projection binds the heir", async () => {
    const rejected = await activeRow("sk-ant-api03-rejected-first")
    const heir = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-heir",
      secret: "sk-ant-api03-heir",
    })
    const local = broker()
    const refusal = {
      bindingId: "unused",
      credentialId: rejected.id,
      revision: getCredential(rejected.id)!.revision,
      status: 401,
    }

    await local.authority.reportFailure(refusal)

    // A single mid-turn hiccup takes nothing away: the account is still the one
    // the provider runs on, and still usable.
    expect(getCredential(rejected.id)).toMatchObject({ is_active: true, health: null })
    expect(getCredential(heir.id)?.is_active).toBe(false)

    await local.authority.reportFailure(refusal)

    expect(getCredential(rejected.id)).toMatchObject({ is_active: false, health: "auth_failed" })
    expect(getCredential(heir.id)?.is_active).toBe(true)
    const projection = bound((await local.projectAuth({ workspaceId }))["claude-sdk"])
    expect((await local.authority.resolve(bindingIdOf(projection.baseUrl)))?.value).toBe("sk-ant-api03-heir")
  })

  test("the operator's own Check needs no second opinion", async () => {
    const rejected = await activeRow("sk-ant-api03-checked")
    const heir = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-checked-heir",
      secret: "sk-ant-api03-checked-heir",
    })

    // What `POST /:id/verify` writes when the provider rejects the account.
    updateCredentialHealth(rejected.id, "auth_failed", Date.now())

    expect(getCredential(rejected.id)).toMatchObject({ is_active: false, health: "auth_failed" })
    expect(getCredential(heir.id)?.is_active).toBe(true)
  })

  test("a Check that finds the account working resets the run of refusals", async () => {
    const account = await activeRow("sk-ant-api03-recovered")
    await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-recovered-heir",
      secret: "sk-ant-api03-recovered-heir",
    })
    const local = broker()
    const refusal = {
      bindingId: "unused",
      credentialId: account.id,
      revision: getCredential(account.id)!.revision,
      status: 401,
    }

    await local.authority.reportFailure(refusal)
    updateCredentialHealth(account.id, "ok", Date.now())
    await local.authority.reportFailure(refusal)

    // The provider's newer word stands between the two refusals, so the second
    // one starts a run rather than finishing the first.
    expect(getCredential(account.id)).toMatchObject({ is_active: true, health: "ok" })
  })

  test("a refusal for a value that has since been replaced starts over", async () => {
    const account = await activeRow("sk-ant-api03-rotated")
    await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-rotated-heir",
      secret: "sk-ant-api03-rotated-heir",
    })
    const local = broker()
    const first = getCredential(account.id)!.revision

    await local.authority.reportFailure({ bindingId: "unused", credentialId: account.id, revision: first, status: 401 })
    await updateCredentialSecret(account.id, "sk-ant-api03-rotated-again")
    const second = getCredential(account.id)!.revision
    await local.authority.reportFailure({ bindingId: "unused", credentialId: account.id, revision: second, status: 401 })

    expect(second).not.toBe(first)
    expect(getCredential(account.id)).toMatchObject({ is_active: true })
  })

  test("reportFailure marks the row only for the revision the request used", async () => {
    const credential = await activeRow("sk-ant-api03-reported")
    const local = broker()
    const failure = { bindingId: "unused", credentialId: credential.id, status: 401 }
    const stale = { ...failure, revision: getCredential(credential.id)!.revision - 1 }
    const current = { ...failure, revision: getCredential(credential.id)!.revision }

    await local.authority.reportFailure(stale)
    await local.authority.reportFailure(stale)
    expect(getCredential(credential.id)?.health).not.toBe("auth_failed")

    await local.authority.reportFailure(current)
    await local.authority.reportFailure(current)
    expect(getCredential(credential.id)?.health).toBe("auth_failed")
    expect(getCredential(credential.id)?.status).toBe("error")
  })

  test("a vendor 403 does not withdraw a working credential", async () => {
    const credential = await activeRow("sk-ant-api03-forbidden")
    const local = broker()

    await local.authority.reportFailure({
      bindingId: "unused",
      credentialId: credential.id,
      revision: getCredential(credential.id)!.revision,
      status: 403,
    })

    expect(getCredential(credential.id)?.health).not.toBe("auth_failed")
  })

  test("a registry outage is an outage, never an empty selection", async () => {
    await activeRow("sk-ant-api03-outage")
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    await withRegistryOutage(async () => {
      // Answering `{}` would tell the harness no account is selected, and the
      // next turn would run on the machine's own login.
      await expect(local.projectAuth({ workspaceId })).rejects.toThrow()
      await expect(local.authority.resolve(id)).rejects.toThrow()
    })

    expect(await local.authority.resolve(id)).toBeDefined()
  })

  test("the handler answers a registry outage 503, never 403", async () => {
    await activeRow("sk-ant-api03-outage-handler")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["claude-sdk"])

    const response = await withRegistryOutage(() => local.handler(
      new Request(`${projection.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": projection.placeholder },
      }),
    ))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "broker_authority_unavailable" } })
  })

  test("the identity carries the org the caller named, and a binding is that org's alone", async () => {
    const credential = await activeRow("sk-ant-api03-org")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId, orgId: "__local__", scope: "local" }))["claude-sdk"])

    expect(local.runtimeIdentity(workspaceId, "__local__")).toMatchObject({ userId: "operator", orgId: "__local__" })
    expect((await local.authority.resolve(bindingIdOf(projection.baseUrl)))?.binding)
      .toMatchObject({ orgId: "__local__", credentialId: credential.id })
    // Another tenant's projection of the same workspace derives different
    // binding ids, so a placeholder minted here names nothing over there.
    expect(await local.projectAuth({ workspaceId, orgId: "org-other" })).toEqual({})
  })

  test("reportFailure marks the row in the org its own binding was minted in", async () => {
    const org = "org-report"
    const credential = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-org-report",
      secret: "sk-ant-api03-org-report",
    }, org)
    expect(setActiveCredentials([credential.id], org)).toMatchObject({ ok: true })
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId, orgId: org }))["claude-sdk"]).baseUrl)

    const refusal = {
      bindingId: id,
      credentialId: credential.id,
      revision: getCredential(credential.id, org)!.revision,
      status: 401,
    }
    await local.authority.reportFailure(refusal)
    await local.authority.reportFailure(refusal)

    // Read in the single-tenant org the row is not in, the revision never
    // matches and a vendor's 401 silently marks nothing at all.
    expect(getCredential(credential.id, org)?.health).toBe("auth_failed")
  })

  test("a provider id that names an Object prototype member binds nothing", async () => {
    // `constructor` reaches `Object.prototype` through a plain-object lookup,
    // so the row reads as bindable and then has no destination to project.
    await activeRow("key-constructor", "constructor")
    const local = broker()

    expect((await local.projectAuth({ workspaceId })).constructor)
      .toEqual({ unavailable: true, reason: "no_destination" })
  })

  test("a data directory that becomes writable is opened on the next projection", async () => {
    const dataDir = path.join(root, `reopen-${randomUUID().slice(0, 8)}`)
    mkdirSync(dataDir, { recursive: true, mode: 0o500 })
    await activeRow("sk-ant-api03-reopen")
    const local = createLocalCredentialBroker({ dataDir, brokerOrigin })
    const refused = (await local.projectAuth({ workspaceId }))["claude-sdk"]
    expect(refused).toMatchObject({ unavailable: true })

    chmodSync(dataDir, 0o700)

    // The fault was the operator's to fix, and they fixed it; a broker that
    // remembers the first failure for the life of the process makes every
    // account permanently unavailable until the server is restarted.
    expect(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).placeholder).toBeTruthy()
  })

  test("the revision a binding reports counts secret writes, not the clock", async () => {
    const credential = await activeRow("sk-ant-api03-rev-one")
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)
    const first = (await local.authority.resolve(id))!.binding.revision

    // Two writes inside one millisecond share `updated_at`; only a counter
    // tells the superseded value from the one stored now.
    await updateCredentialSecret(credential.id, "sk-ant-api03-rev-two")
    const second = (await local.authority.resolve(id))!.binding.revision
    expect(second).toBe(first + 1)

    await local.authority.reportFailure({ bindingId: id, credentialId: credential.id, revision: first, status: 401 })
    await local.authority.reportFailure({ bindingId: id, credentialId: credential.id, revision: first, status: 401 })
    expect(getCredential(credential.id)?.health).not.toBe("auth_failed")

    await local.authority.reportFailure({ bindingId: id, credentialId: credential.id, revision: second, status: 401 })
    await local.authority.reportFailure({ bindingId: id, credentialId: credential.id, revision: second, status: 401 })
    expect(getCredential(credential.id)?.health).toBe("auth_failed")
  })

  test("moving the active mark leaves a running turn's binding resolvable", async () => {
    const first = await activeRow("sk-ant-api03-mark-first")
    const local = broker()
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    const second = await activeRow("sk-ant-api03-mark-second")
    expect(getCredential(second.id)?.is_active).toBe(true)
    expect(getCredential(first.id)?.is_active).toBe(false)

    // The turn already running keeps spending the account it started on.
    expect((await local.authority.resolve(id))?.value).toBe("sk-ant-api03-mark-first")
    // The next projection is what moves the harness onto the new account.
    const next = bound((await local.projectAuth({ workspaceId }))["claude-sdk"])
    expect((await local.authority.resolve(bindingIdOf(next.baseUrl)))?.value).toBe("sk-ant-api03-mark-second")

    updateCredentialStatus(first.id, "revoked")
    expect(await local.authority.resolve(id)).toBeUndefined()
  })

  test("the anthropic destination reaches the turn's routes and nothing else", async () => {
    await activeRow("sk-ant-api03-narrow")
    const local = broker()
    const projection = bound((await local.projectAuth({ workspaceId }))["claude-sdk"])
    const destination = (await local.authority.resolve(bindingIdOf(projection.baseUrl)))!.binding.destination
    expect(destination.pathPrefixes).toEqual(["/v1/messages", "/v1/models"])

    const realFetch = globalThis.fetch
    const reached: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      reached.push(new URL(url instanceof Request ? url.url : url).pathname)
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const reach = (route: string) => local.handler(new Request(`${projection.baseUrl}${route}`, {
        method: "POST",
        headers: { "x-api-key": projection.placeholder },
      }))
      for (const allowed of ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"]) {
        expect((await reach(allowed)).status, allowed).toBe(200)
      }
      for (const refused of ["/v1/files", "/v1/organizations/api_keys", "/v1/complete"]) {
        expect((await reach(refused)).status, refused).toBe(403)
      }
      expect(reached).toEqual(["/v1/messages", "/v1/messages/count_tokens", "/v1/models"])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a broker origin the harness could not safely reach is refused at projection", async () => {
    await activeRow("sk-ant-api03-origin")
    const remote = createLocalCredentialBroker({ dataDir: root, brokerOrigin: "http://10.0.0.4:2595" })

    await expect(remote.projectAuth({ workspaceId })).rejects.toThrow(/HTTPS or loopback/)
  })

  test("a brokered request marks the row used at most once a minute", async () => {
    const credential = await activeRow("sk-ant-api03-used")
    let clock = Date.parse("2026-09-13T00:00:00.000Z")
    const local = createLocalCredentialBroker({ dataDir: root, brokerOrigin, now: () => clock })
    const id = bindingIdOf(bound((await local.projectAuth({ workspaceId }))["claude-sdk"]).baseUrl)

    await local.authority.resolve(id)
    const marked = getCredential(credential.id)!.last_used_at
    expect(marked).toBe(clock)

    // A streaming turn resolves once per request; a write each time turns it
    // into a stream of registry writes.
    clock += 30_000
    await local.authority.resolve(id)
    await local.authority.resolve(id)
    expect(getCredential(credential.id)?.last_used_at).toBe(marked)

    clock += 31_000
    await local.authority.resolve(id)
    expect(getCredential(credential.id)?.last_used_at).toBe(clock)
  })

  test("a key file shorter than the signing key is repaired by hand, never overwritten", async () => {
    const dataDir = path.join(root, `short-key-${randomUUID().slice(0, 8)}`)
    const keyFile = path.join(dataDir, "credentials", "broker.key")
    mkdirSync(path.dirname(keyFile), { recursive: true })
    await fs.writeFile(keyFile, Buffer.alloc(8, 7))

    await activeRow("sk-ant-api03-short")
    const rows = await broker(dataDir).projectAuth({ workspaceId })

    expect(rows["claude-sdk"]).toMatchObject({ unavailable: true })
    expect((rows["claude-sdk"] as { reason: string }).reason).toContain("shorter than 32 bytes")
    expect(readFileSync(keyFile).byteLength).toBe(8)
  })

  test("a key file and directory left readable by others are narrowed on open", async () => {
    const dataDir = path.join(root, `wide-${randomUUID().slice(0, 8)}`)
    const dir = path.join(dataDir, "credentials")
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    await fs.writeFile(path.join(dir, "broker.key"), Buffer.alloc(32, 3), { mode: 0o644 })

    broker(dataDir).runtimeIdentity(workspaceId)

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(dir, "broker.key")).mode & 0o777).toBe(0o600)
  })

  test("a data directory this process cannot write reports unavailable rather than failing to boot", async () => {
    const parent = path.join(root, `locked-${randomUUID().slice(0, 8)}`)
    mkdirSync(parent, { recursive: true })
    await fs.chmod(parent, 0o500)
    await activeRow("sk-ant-api03-locked")
    try {
      const local = broker(path.join(parent, "data"))
      const rows = await local.projectAuth({ workspaceId })

      expect(rows["claude-sdk"]).toMatchObject({ unavailable: true })
      expect((rows["claude-sdk"] as { reason: string }).reason).toContain("broker_unavailable")
    } finally {
      await fs.chmod(parent, 0o700)
    }
  })

  test("a lost generation counter starts past every generation this machine minted", async () => {
    const dataDir = path.join(root, `generation-${randomUUID().slice(0, 8)}`)
    const before = Date.now()
    const counter = path.join(dataDir, "credentials", "broker-generation")
    const first = broker(dataDir).runtimeIdentity(workspaceId).leaseGeneration
    expect(first).toBeGreaterThanOrEqual(before)

    await fs.rm(counter)
    const relaunched = broker(dataDir).runtimeIdentity(workspaceId).leaseGeneration

    // Counting from 1 again would re-issue a generation an old placeholder
    // already names, and that placeholder would validate a second time.
    expect(relaunched).toBeGreaterThanOrEqual(first)
  })
})
