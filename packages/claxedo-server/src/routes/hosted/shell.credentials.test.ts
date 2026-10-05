import { afterAll, describe, expect, test } from "vitest"
import { projectPiProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-projection"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import type { OpenCodeCatalog } from "@claxedo/server-core/credentials/opencode-provider-projection"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"

// An unverifiable bearer falls back to `verifyCliAccessBearer`, which reads
// these from process.env. Clear them so "invalid token" is deterministic here
// rather than depending on the developer's shell.
const prevCliToken = {
  pub: process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM,
  runtimePub: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
}
delete process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM
delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM

afterAll(() => {
  if (prevCliToken.pub !== undefined) process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM = prevCliToken.pub
  if (prevCliToken.runtimePub !== undefined) {
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = prevCliToken.runtimePub
  }
})

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

// Two separate paying owners. `token-a` must never be able to act as `owner_b`.
const OWNERS: Record<string, { subject: string; orgId: string }> = {
  "token-a": { subject: "user_a", orgId: "org_a" },
  "token-b": { subject: "user_b", orgId: "org_b" },
}

const verifier = async (token: string) => {
  const owner = OWNERS[token]
  if (!owner) throw Object.assign(new Error("unknown token"), { status: 401 })
  return {
    mode: "signed" as const,
    user: {
      subject: owner.subject,
      tokenIdentifier: `${signedConfig.enabled ? signedConfig.issuer : ""}|${owner.subject}`,
      issuer: "https://example.issuer.dev",
      orgId: owner.orgId,
    },
  }
}

function app() {
  return HostedShellRoutes({ authConfig: signedConfig, verifier })
}

test("hosted OpenCode catalog authenticates the caller and serves summary and provider views", async () => {
  const calls: unknown[] = []
  const catalog = HostedShellRoutes({ authConfig: signedConfig, verifier, opencodeProviderCatalog: async (auth, workspaceId): Promise<OpenCodeCatalog> => {
    calls.push({ owner: auth.user.subject, workspaceId })
    return { all: [
      { id: "openai", name: "OpenAI", env: [], source: "api", models: { gpt: { id: "gpt", name: "GPT", connected: true, free: false } } },
      { id: "anthropic", name: "Anthropic", env: [], source: "config", models: { sonnet: { id: "sonnet", name: "Sonnet", connected: false, free: false } } },
    ], connected: ["openai"], default: { openai: "gpt" } }
  } })
  const route = "/api/claxedo/agent-config/providers?nativeHarness=opencode&workspaceId=ws_a"
  const headers = { authorization: "Bearer token-a" }
  expect((await catalog.request(route)).status).toBe(401)
  expect(calls).toEqual([])
  const summary = await catalog.request(`${route}&view=summary`, { headers })
  expect(summary.status).toBe(200)
  expect((await summary.json()).all[1].models).toEqual({})
  const detail = await catalog.request(`${route}&provider=anthropic`, { headers })
  expect((await detail.json()).all).toMatchObject([{ id: "anthropic", models: { sonnet: { id: "sonnet" } } }])
  expect(calls).toEqual(Array(2).fill({ owner: "user_a", workspaceId: "ws_a" }))
  expect((await catalog.request(`${route}&view=invalid`, { headers })).status).toBe(400)
  expect((await catalog.request(`${route}&provider=missing`, { headers })).status).toBe(404)
})

describe("sign-in methods", () => {
  test("every native harness is answered with the methods a cloud sandbox can spend: Codex's ChatGPT plan, never OpenAI's", async () => {
    const methods = async (harness: string) => {
      const response = await app().request(`/api/claxedo/agent-config/providers/auth?nativeHarness=${harness}`, { headers: { authorization: "Bearer token-a" } })
      return [response.status, await response.json()] as const
    }
    expect((await app().request("/api/claxedo/agent-config/providers/auth?nativeHarness=claude")).status).toBe(401)
    expect((await methods("claude"))[1]).toEqual({
      "claude-sdk": [
        { type: "token", label: "Claude subscription token", command: "claude setup-token" },
        { type: "api", label: "API Key" },
      ],
    })
    const plan = { type: "oauth", label: "ChatGPT Pro/Plus (headless)" }
    expect((await methods("codex"))[1]).toEqual({ "codex-app-server": [plan, { type: "api", label: "API Key" }] })
    const [, pi] = await methods("pi")
    expect(pi["openai-codex"]).toEqual([plan])
    expect(pi.openai).toEqual([{ type: "api", label: "API Key" }])
    expect(pi.openrouter).toEqual([{ type: "api", label: "API Key" }])
    expect((await methods("not-a-harness"))[0]).toBe(400)
  })
})

describe("the Pi provider catalog", () => {
  const plan = () => projectPiProviderCatalog(new Map([["openai-codex", "openai-codex"]]))

  test("provider catalog uses the verified owner and explicit unavailable states", async () => {
    const calls: string[] = []
    const catalog = HostedShellRoutes({
      authConfig: signedConfig,
      verifier,
      piProviderCatalog: async (auth) => {
        calls.push(auth.user.orgId!)
        return plan()
      },
    })
    const route = "/api/claxedo/agent-config/providers?nativeHarness=pi"
    expect((await catalog.request(route)).status).toBe(401)
    const response = await catalog.request(`${route}&workspaceId=org_b`, { headers: { authorization: "Bearer token-a" } })
    expect(response.status).toBe(200)
    expect((await response.json()).connected).toEqual(["openai-codex"])
    expect(calls).toEqual(["org_a"])
    expect((await app().request(route, { headers: { authorization: "Bearer token-a" } })).status).toBe(503)
    expect((await catalog.request("/api/claxedo/agent-config/providers?nativeHarness=claude", { headers: { authorization: "Bearer token-a" } })).status).toBe(400)
  })

  test("a Pi draft's options are the launch models of the providers the account connected, with no runtime asked", async () => {
    const catalog = HostedShellRoutes({ authConfig: signedConfig, verifier, piProviderCatalog: async () => plan() })
    const route = "/api/claxedo/agent-config/harness/options?nativeHarness=pi"
    expect((await catalog.request(route)).status).toBe(401)
    const response = await catalog.request(route, { headers: { authorization: "Bearer token-a" } })
    expect(response.status).toBe(200)
    const body = await response.json() as { options: Array<{ id: string; selectOptions?: Array<{ id: string }> }> }
    const models = body.options.find((option) => option.id === "model")?.selectOptions?.map((option) => option.id) ?? []
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.startsWith("openai-codex/"))).toBe(true)
    expect((await catalog.request("/api/claxedo/agent-config/harness/options?nativeHarness=codex", { headers: { authorization: "Bearer token-a" } })).status).toBe(400)
    expect((await app().request(route, { headers: { authorization: "Bearer token-a" } })).status).toBe(503)
  })
})

describe("a native harness draft on a cloud workspace", () => {
  const anthropic = { unavailable: true as const, reason: "harness_needs_brokering" }
  const edge = { baseUrl: "https://api.anthropic.com", placeholderEnv: "CLAXEDO_PROVIDER_ANTHROPIC_1F", authMode: "api-key" as const }
  const snapshots: Record<string, CredentialSnapshot> = {
    ws_boat: { machineOwnerUserId: "user_a", accounts: { user_a: { anthropic, "claude-sdk": anthropic } } },
    ws_edge: { machineOwnerUserId: "user_a", accounts: { user_a: { anthropic: edge } } },
  }
  const asked: string[] = []
  const routes = HostedShellRoutes({ authConfig: signedConfig, verifier, draftCredentials: async (auth, workspaceId) => {
    asked.push(`${auth.user.subject} ${workspaceId}`)
    return snapshots[workspaceId]
  } })
  const read = (query: string) => routes.request(`/api/claxedo/agent-config/harness/options?${query}`, { headers: { authorization: "Bearer token-a" } })

  test("is refused here, with the Pi model that spends the same account, when the organization's sandbox provider cannot keep the key out", async () => {
    const refused = await read("nativeHarness=claude&workspaceId=ws_boat&model=claude-sonnet-5-5")
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: {
      code: "harness_needs_brokering",
      message: "This cloud provider can't keep the account's key out of the workspace.",
      details: { retryable: false, alternative: { harness: "pi", model: { id: "anthropic/claude-sonnet-5-5", name: expect.any(String) } } },
    } })
    const noAccount = await read("nativeHarness=codex&workspaceId=ws_boat")
    expect(noAccount.status).toBe(409)
    expect((await noAccount.json()).error.code).toBe("account_unavailable")
  })

  test("is left to its runtime when the provider brokers the key, and a placeholder the sandbox would be handed is no refusal", async () => {
    expect((await read("nativeHarness=claude&workspaceId=ws_edge")).status).toBe(204)
    expect(asked).toContain("user_a ws_edge")
  })

  test("names its workspace, which the caller must be able to open, and a native harness", async () => {
    expect((await read("nativeHarness=claude")).status).toBe(400)
    expect((await read("nativeHarness=claude&workspaceId=ws_gone")).status).toBe(404)
    expect((await read("connectionId=scripted&workspaceId=ws_boat")).status).toBe(400)
    expect((await app().request("/api/claxedo/agent-config/harness/options?nativeHarness=claude&workspaceId=ws_boat", { headers: { authorization: "Bearer token-a" } })).status).toBe(404)
  })
})
