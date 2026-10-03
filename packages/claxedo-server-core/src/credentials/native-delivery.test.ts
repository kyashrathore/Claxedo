import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `native-delivery-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("./backend-registry")
const registryModule = await import("./registry")
const { putCredential, setActiveCredentials, updateCredentialHealth, deleteCredential, listCredentials } =
  await import("./registry")
const { credentialReach } = await import("./reach")
const {
  nativeDeliveryDigest,
  nativeDeliveryDigestEntries,
  nativeProviderAuth,
  nativeProviderDeliveries,
  nativeProviderSecrets,
  projectNativeProviderAuth,
} = await import("./native-delivery")
const { configureAgentConfig, disposeAgentConfig } = await import("../agent-config/index")
const { createClaxedoRuntimeConfig } = await import("../hosts/workspace-runtime/runtime-config")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

const API_KEY = "sk-ant-api03-fixture-key"
const SUBSCRIPTION = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-fixture" } })
const consent = { at: 1, surface: "desktop_discovery" } as const

/** Two marks in the same millisecond carry the same `updated_at`; this separates them. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function shared(input: { provider_id: string; kind: "api_key" | "oauth_token"; secret: string; label?: string }) {
  return await putCredential({ owner: "local",
    source: "managed",
    scope: "shared",
    consent,
    ...input,
  })
}

describe("native provider delivery", () => {
  let backend: ReturnType<typeof createTestBackend>

  beforeEach(async () => {
    backend = createTestBackend()
    setBackendOverride(backend)
    for (const row of listCredentials()) await deleteCredential(row.id)
  })

  afterAll(async () => {
    disposeAgentConfig()
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("a sandbox is delivered the org account only for a provider its owner chose it for, and then not their own", async () => {
    await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    const org = await putCredential({ owner: null, source: "managed", scope: "shared", consent,
      provider_id: "claude-sdk", kind: "api_key", secret: "sk-ant-api03-org-key" })
    const { setAccountSources, accountSelections } = await import("./account-source")
    const delivered = async () => nativeProviderSecrets(await nativeProviderDeliveries({
      owner: "local", machineOwnerUserId: "local", selections: accountSelections(), secretBrokering: "native",
    })).map((secret) => secret.value)

    expect(await delivered()).toEqual([API_KEY])
    setAccountSources(["claude-sdk"], "org", undefined, "local")
    expect(await delivered()).toEqual(["sk-ant-api03-org-key"])
    await projectNativeProviderAuth({ scope: "shared", sandboxOwner: "local", machineOwnerUserId: "local", secretBrokering: "native" })
      .then((auth) => expect(Object.keys(auth.accounts.local ?? {})).toEqual(["claude-sdk"]))
    await deleteCredential(org.id)
    expect(await delivered()).toEqual([])
    await expect(projectNativeProviderAuth({ scope: "shared", sandboxOwner: "local", machineOwnerUserId: "local", secretBrokering: "native" }))
      .resolves.toMatchObject({ accounts: { local: { "claude-sdk": { unavailable: true, reason: "org_account_unavailable" } } } })
    setAccountSources(["claude-sdk"], "own", undefined, "local")
  })

  test("a Pi catalog shows connected exactly what the person would spend", async () => {
    const { piProviderCatalog } = await import("./pi-provider-catalog")
    const { setAccountSources } = await import("./account-source")
    await putCredential({ owner: null, source: "managed", provider_id: "anthropic", kind: "api_key", secret: "sk-ant-api03-org-pi" })
    const connected = () => piProviderCatalog("local").connected as readonly string[]
    expect(connected()).not.toContain("anthropic")
    setAccountSources(["anthropic"], "org", undefined, "local")
    expect(connected()).toContain("anthropic")
    setAccountSources(["anthropic"], "own", undefined, "local")
    expect(connected()).not.toContain("anthropic")
  })

  test("an active API key becomes one secret for the vendor host and a projection naming its variable", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(deliveries)).toEqual([{
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
      value: API_KEY,
      hosts: ["api.anthropic.com"],
      header: "x-api-key",
      methods: ["POST", "GET"],
      pathPrefixes: ["/v1/messages", "/v1/models"],
    }])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
  })

  test("the projection never carries the secret", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const auth = nativeProviderAuth(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }), { owner: "local", machineOwnerUserId: "local", selections: {} })
    expect(JSON.stringify(auth)).not.toContain(API_KEY)
  })

  test("a subscription login is delivered as a bearer, scheme and all", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "oauth_token", secret: SUBSCRIPTION })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(deliveries)).toEqual([{
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
      value: "sk-ant-oat01-fixture",
      hosts: ["api.anthropic.com"],
      header: "Authorization",
      scheme: "Bearer",
      methods: ["POST", "GET"],
      pathPrefixes: ["/v1/messages", "/v1/models"],
    }])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local["claude-sdk"]).toMatchObject({ authMode: "bearer" })
  })

  test("a marked account the vendor rejected is projected unavailable and delivers no secret", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")
    updateCredentialHealth(credential.id, "auth_failed", 2)

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "claude-sdk": { unavailable: true, reason: "auth_failed" },
    })
  })

  test("two accounts on one provider deliver only the marked one", async () => {
    const first = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY, label: "first" })
    const second = await shared({
      provider_id: "claude-sdk",
      kind: "oauth_token",
      secret: SUBSCRIPTION,
      label: "second",
    })
    setActiveCredentials([first.id], undefined, "local")
    expect(nativeProviderSecrets(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))).toEqual([
      expect.objectContaining({ value: API_KEY }),
    ])

    setActiveCredentials([second.id], undefined, "local")
    expect(nativeProviderSecrets(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))).toEqual([
      expect.objectContaining({ value: "sk-ant-oat01-fixture" }),
    ])
  })

  test("a provider with no vendor destination is refused rather than dropped", async () => {
    const credential = await shared({ provider_id: "some-new-vendor", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "some-new-vendor": { unavailable: true, reason: "no_destination" },
    })
  })

  test("an account whose vendor needs a companion header is refused rather than half-delivered", async () => {
    const credential = await shared({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      secret: JSON.stringify({ access_token: "chatgpt-fixture", account_id: "acct_1" }),
    })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "codex-app-server": { unavailable: true, reason: "native_delivery_needs_companion_header" },
    })
  })

  test("a Cursor account reaches a native-brokering sandbox scoped to its key exchange alone", async () => {
    const credential = await shared({ provider_id: "cursor-sdk", kind: "api_key", secret: "cursor-private-key" })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    const [secret] = nativeProviderSecrets(deliveries)
    expect(nativeProviderSecrets(deliveries)).toEqual([{
      name: secret.name, value: "cursor-private-key", hosts: ["api2.cursor.sh"], header: "Authorization", scheme: "Bearer",
      methods: ["POST"], pathPrefixes: ["/auth/exchange_user_api_key"],
    }])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "cursor-sdk": { baseUrl: "https://api2.cursor.sh", placeholderEnv: secret.name, authMode: "bearer" },
    })
    expect(JSON.stringify(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }))).not.toContain("cursor-private-key")
    expect(credentialReach({ provider_id: "cursor-sdk", kind: "api_key" })).toEqual({ local: true, cloud: true })
  })

  test("a Cursor account stays out of a sandbox whose driver cannot broker", async () => {
    const credential = await shared({ provider_id: "cursor-sdk", kind: "api_key", secret: "cursor-private-key" })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "none" })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "cursor-sdk": { unavailable: true, reason: "secret_brokering_unsupported" },
    })
    expect(JSON.stringify(deliveries)).not.toContain("cursor-private-key")
  })

  test("a driver that cannot broker refuses the turn instead of the provisioning", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "none" })
    // Nothing for the manager to fail closed on: handing it a native secret a
    // "none" driver cannot carry leaves the workspace unprovisionable forever.
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" },
    })
  })

  test("an unstated broker capability refuses the same way an incapable driver does", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {} })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" },
    })
  })

  test("an unrecognized broker capability refuses rather than falls through to delivery", async () => {
    // A malformed external driver implementation can declare a value the
    // contract does not define; typed metadata cannot be the only gate.
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "proxy" as never })
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local).toEqual({
      "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" },
    })
  })

  test("a secret backend that throws takes down its own row and no other", async () => {
    const first = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    const second = await shared({ provider_id: "openrouter", kind: "api_key", secret: "sk-or-fixture" })
    setActiveCredentials([first.id, second.id], undefined, "local")
    const stored = backend
    setBackendOverride({
      ...stored,
      get: async (ref: string) => {
        const secret = await stored.get(ref)
        if (secret === API_KEY) throw new Error("keychain is locked")
        return secret
      },
    })

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })

    expect(nativeProviderAuth(deliveries, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local["claude-sdk"]).toEqual({
      unavailable: true,
      reason: "unreadable_secret",
    })
    expect(nativeProviderSecrets(deliveries)).toEqual([expect.objectContaining({
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_OPENROUTER_[0-9A-F]{24}$/),
    })])
  })

  test("the account marked most recently claims a shared vendor host, and the other is told so", async () => {
    const key = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    const subscription = await shared({ provider_id: "anthropic", kind: "oauth_token", secret: SUBSCRIPTION })
    setActiveCredentials([key.id], undefined, "local")
    await tick()
    setActiveCredentials([subscription.id], undefined, "local")

    const first = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(first)).toEqual([expect.objectContaining({
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_ANTHROPIC_[0-9A-F]{24}$/),
      hosts: ["api.anthropic.com"],
    })])
    expect(nativeProviderAuth(first, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local["claude-sdk"]).toEqual({
      unavailable: true,
      reason: "duplicate_destination_host: api.anthropic.com is delivered for anthropic, marked more recently",
    })

    // The mark decides, not the provider id: marking the other one again moves
    // the host to it.
    await tick()
    setActiveCredentials([key.id], undefined, "local")

    const second = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })
    expect(nativeProviderSecrets(second)).toEqual([expect.objectContaining({
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
    })])
    expect(nativeProviderAuth(second, { owner: "local", machineOwnerUserId: "local", selections: {} }).accounts.local.anthropic).toMatchObject({ unavailable: true })
  })

  test("checking or renaming an account does not hand it a host another account claimed", async () => {
    // `updated_at` moves on a Check and on a rename, so reading it here let a
    // Check press the host away from the account the operator chose.
    const key = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    const subscription = await shared({ provider_id: "anthropic", kind: "oauth_token", secret: SUBSCRIPTION })
    setActiveCredentials([key.id], undefined, "local")
    await tick()
    setActiveCredentials([subscription.id], undefined, "local")

    await tick()
    updateCredentialHealth(key.id, "ok", Date.now())
    await registryModule.updateCredentialLabel(key.id, "work key")

    expect(nativeProviderSecrets(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))).toEqual([expect.objectContaining({
      name: expect.stringMatching(/^CLAXEDO_PROVIDER_ANTHROPIC_[0-9A-F]{24}$/),
    })])
  })

  test("the digest moves with a rotation and not with a re-read", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")
    const before = nativeDeliveryDigest(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))
    expect(nativeDeliveryDigest(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))).toBe(before)
    expect(before).not.toContain(API_KEY)

    await registryModule.updateCredentialSecret(credential.id, "sk-ant-api03-rotated")

    expect(nativeDeliveryDigest(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))).not.toBe(before)
  })

  test("the digest moves when the operator switches to another account at the same revision", async () => {
    // Two accounts for one provider are both at revision 1, so a digest built
    // from the destination and the revision alone reads the switch as no
    // change and leaves the sandbox spending the account the operator left.
    const first = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY, label: "one" })
    setActiveCredentials([first.id], undefined, "local")
    const before = nativeDeliveryDigest(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))
    await tick()
    const second = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: "sk-ant-api03-second", label: "two" })
    setActiveCredentials([second.id], undefined, "local")

    const after = nativeDeliveryDigest(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" }))

    expect(first.revision).toBe(second.revision)
    expect(after).not.toBe(before)
    expect(nativeDeliveryDigestEntries(after).map((row) => row.providerId)).toEqual(["claude-sdk"])
  })

  test("a digest names the providers it installed a secret for, and nothing at all when empty", () => {
    expect(nativeDeliveryDigestEntries("")).toEqual([])
    expect(nativeDeliveryDigestEntries(nativeDeliveryDigest([]))).toEqual([])
  })

  test("every delivery names the account it resolved to", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")

    const deliveries = await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })

    expect(deliveries.map((row) => [row.providerId, row.credentialId]))
      .toEqual([["claude-sdk", credential.id]])
  })

  test("reach is read from the delivery rules rather than from the row being stored", () => {
    // A ChatGPT subscription answers on a backend that reads a companion
    // account header, and a provider edge attaches one header per secret.
    expect(credentialReach({ provider_id: "openai", kind: "oauth_token" }))
      .toEqual({ local: true, cloud: false, reason: "native_delivery_needs_companion_header" })
    expect(credentialReach({ provider_id: "openai", kind: "api_key" })).toEqual({ local: true, cloud: true })
    expect(credentialReach({ provider_id: "claude-sdk", kind: "oauth_token" })).toEqual({ local: true, cloud: true })
    expect(credentialReach({ provider_id: "modal", kind: "sandbox_driver" }))
      .toEqual({ local: true, cloud: false, reason: "no_destination" })
  })

  test("a replacement with no expiry of its own clears the one the replaced material carried", async () => {
    // The verifier reads a stored expiry as the material's own, so an expiry
    // carried over from the replaced secret answers "expired" for a key that
    // has nothing to refresh with, and the reconnect never takes effect.
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    await registryModule.updateCredentialSecret(credential.id, "sk-ant-api03-first", 1_000)
    expect(registryModule.credentialById(credential.id, { onOutage: "throw" })?.expires_at).toBe(1_000)

    await registryModule.updateCredentialSecret(credential.id, "sk-ant-api03-second", null)

    const stored = registryModule.credentialById(credential.id, { onOutage: "throw" })
    expect(stored?.expires_at).toBeNull()
    expect(await registryModule.readSecretById(credential.id)).toBe("sk-ant-api03-second")

    // Omitted still means "keep what is stored", which is what an OAuth refresh
    // that reports no new expiry needs.
    await registryModule.updateCredentialSecret(credential.id, "sk-ant-api03-third", 2_000)
    await registryModule.updateCredentialSecret(credential.id, "sk-ant-api03-fourth")
    expect(registryModule.credentialById(credential.id, { onOutage: "throw" })?.expires_at).toBe(2_000)
  })

  test("a none-driver snapshot reaches the runtime saying the credential cannot be delivered", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")
    configureAgentConfig({ projectAuth: (input) => projectNativeProviderAuth({ ...input, sandboxOwner: "local", machineOwnerUserId: "local" }) })

    const snapshot = await createClaxedoRuntimeConfig({
      secretScope: "shared",
      workspaceId: "ws_1",
      secretBrokering: "none",
    })

    // The whole path, not the authority alone: a composition that answers
    // shared scope with nothing sends the harness no projection, and a harness
    // with no projection runs on the login its image carries.
    expect(snapshot.auth.accounts.local).toEqual({
      "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" },
    })
    expect(JSON.stringify(snapshot)).not.toContain(API_KEY)
  })

  test("a native-driver snapshot reaches the runtime naming the variable its provider fills", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id], undefined, "local")
    configureAgentConfig({ projectAuth: (input) => projectNativeProviderAuth({ ...input, sandboxOwner: "local", machineOwnerUserId: "local" }) })

    const snapshot = await createClaxedoRuntimeConfig({
      secretScope: "shared",
      workspaceId: "ws_1",
      secretBrokering: "native",
    })

    expect(snapshot.auth.accounts.local).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
  })

  test("an account kept out of shared scope is delivered to nothing", async () => {
    const credential = await putCredential({ owner: "local",
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      secret: API_KEY,
    })
    setActiveCredentials([credential.id], undefined, "local")
    expect(await nativeProviderDeliveries({ owner: "local", machineOwnerUserId: "local", selections: {}, secretBrokering: "native" })).toEqual([])
  })
})
