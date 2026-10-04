import { afterAll, describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import type { OpenCodeCatalog } from "@claxedo/server-core/credentials/opencode-provider-projection"

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
  test("provider catalog uses the verified owner and explicit unavailable states", async () => {
    const calls: string[] = []
    const catalog = HostedShellRoutes({
      authConfig: signedConfig,
      verifier,
      piProviderCatalog: async (auth) => {
        calls.push(auth.user.orgId!)
        return { all: [], connected: [auth.user.orgId], default: {} }
      },
    })
    const route = "/api/claxedo/agent-config/providers?nativeHarness=pi"
    expect((await catalog.request(route)).status).toBe(401)
    const response = await catalog.request(`${route}&workspaceId=org_b`, { headers: { authorization: "Bearer token-a" } })
    expect(response.status).toBe(200)
    expect((await response.json()).connected).toEqual(["org_a"])
    expect(calls).toEqual(["org_a"])
    expect((await app().request(route, { headers: { authorization: "Bearer token-a" } })).status).toBe(503)
    expect((await catalog.request("/api/claxedo/agent-config/providers?nativeHarness=claude", { headers: { authorization: "Bearer token-a" } })).status).toBe(400)
  })
})
