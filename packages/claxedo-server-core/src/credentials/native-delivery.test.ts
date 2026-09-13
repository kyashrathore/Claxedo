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
const { putCredential, setActiveCredentials, updateCredentialHealth, deleteCredential, listCredentials } =
  await import("./registry")
const { nativeProviderAuth, nativeProviderDeliveries, nativeProviderSecrets, providerPlaceholderEnv } =
  await import("./native-delivery")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

const API_KEY = "sk-ant-api03-fixture-key"
const SUBSCRIPTION = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-fixture" } })
const consent = { at: 1, surface: "desktop_discovery" } as const

async function shared(input: { provider_id: string; kind: "api_key" | "oauth_token"; secret: string; label?: string }) {
  return await putCredential({
    source: "managed",
    scope: "shared",
    consent,
    ...input,
  })
}

describe("native provider delivery", () => {
  beforeEach(async () => {
    setBackendOverride(createTestBackend())
    for (const row of listCredentials()) await deleteCredential(row.id)
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("the placeholder variable is one name per provider", () => {
    expect(providerPlaceholderEnv("claude-sdk")).toBe("CLAXEDO_PROVIDER_CLAUDE_SDK")
    expect(providerPlaceholderEnv("openai")).toBe("CLAXEDO_PROVIDER_OPENAI")
  })

  test("an active API key becomes one secret for the vendor host and a projection naming its variable", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id])

    const deliveries = await nativeProviderDeliveries()
    expect(nativeProviderSecrets(deliveries)).toEqual([{
      name: "CLAXEDO_PROVIDER_CLAUDE_SDK",
      value: API_KEY,
      hosts: ["api.anthropic.com"],
      header: "x-api-key",
    }])
    expect(nativeProviderAuth(deliveries)).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
  })

  test("the projection never carries the secret", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id])

    const auth = nativeProviderAuth(await nativeProviderDeliveries())
    expect(JSON.stringify(auth)).not.toContain(API_KEY)
  })

  test("a subscription login is delivered as a bearer, scheme and all", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "oauth_token", secret: SUBSCRIPTION })
    setActiveCredentials([credential.id])

    const deliveries = await nativeProviderDeliveries()
    expect(nativeProviderSecrets(deliveries)).toEqual([{
      name: "CLAXEDO_PROVIDER_CLAUDE_SDK",
      value: "sk-ant-oat01-fixture",
      hosts: ["api.anthropic.com"],
      header: "Authorization",
      scheme: "Bearer",
    }])
    expect(nativeProviderAuth(deliveries)["claude-sdk"]).toMatchObject({ authMode: "bearer" })
  })

  test("a marked account the vendor rejected is projected unavailable and delivers no secret", async () => {
    const credential = await shared({ provider_id: "claude-sdk", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id])
    updateCredentialHealth(credential.id, "auth_failed", 2)

    const deliveries = await nativeProviderDeliveries()
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries)).toEqual({
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
    setActiveCredentials([first.id])
    expect(nativeProviderSecrets(await nativeProviderDeliveries())).toEqual([
      expect.objectContaining({ value: API_KEY }),
    ])

    setActiveCredentials([second.id])
    expect(nativeProviderSecrets(await nativeProviderDeliveries())).toEqual([
      expect.objectContaining({ value: "sk-ant-oat01-fixture" }),
    ])
  })

  test("a provider with no vendor destination is refused rather than dropped", async () => {
    const credential = await shared({ provider_id: "some-new-vendor", kind: "api_key", secret: API_KEY })
    setActiveCredentials([credential.id])

    const deliveries = await nativeProviderDeliveries()
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries)).toEqual({
      "some-new-vendor": { unavailable: true, reason: "no_destination" },
    })
  })

  test("an account whose vendor needs a companion header is refused rather than half-delivered", async () => {
    const credential = await shared({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      secret: JSON.stringify({ access_token: "chatgpt-fixture", account_id: "acct_1" }),
    })
    setActiveCredentials([credential.id])

    const deliveries = await nativeProviderDeliveries()
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(nativeProviderAuth(deliveries)).toEqual({
      "codex-app-server": { unavailable: true, reason: "native_delivery_needs_companion_header" },
    })
  })

  test("an account kept out of shared scope is delivered to nothing", async () => {
    const credential = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      secret: API_KEY,
    })
    setActiveCredentials([credential.id])
    expect(await nativeProviderDeliveries()).toEqual([])
  })
})
