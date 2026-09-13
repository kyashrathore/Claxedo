import { describe, expect, test } from "bun:test"
import {
  connectAIKey,
  discoverAIConnections,
  loadMachineLogins,
  saveDiscoveredAIConnections,
  useMachineLogin,
  verifyProviderAIConnections,
  type AIConnectRequest,
} from "./ai-connect-api"

function requests(responses: Response[]) {
  const calls: Array<{ input: Parameters<AIConnectRequest>[0]; init?: RequestInit }> = []
  const request: AIConnectRequest = async (input, init) => {
    calls.push({ input, init })
    const response = responses.shift()
    if (!response) throw new Error("unexpected request")
    return response
  }
  return { calls, request }
}

describe("AI connect API", () => {
  test("discovers redacted connection metadata without retaining server extras", async () => {
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{
        provider_id: "anthropic",
        kind: "oauth_token",
        label: "Claude subscription",
        account_id: "ac…12",
        origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
        fresh_until: 123,
        secret: "must-not-retain",
      }],
    })])

    await expect(discoverAIConnections({ request: stub.request })).resolves.toEqual({
      discoveryId: "discovery-1",
      items: [{
        providerId: "anthropic",
        kind: "oauth_token",
        label: "Claude subscription",
        accountId: "ac…12",
        origin: "Environment variable CLAUDE_CODE_OAUTH_TOKEN",
        freshUntil: 123,
      }],
    })
    expect(JSON.stringify(await stub.calls)).not.toContain("must-not-retain")
    expect(stub.calls[0].input).toMatchObject({ action: "discover" })
  })

  test("reads each harness's own login, dropping a row that names no harness", async () => {
    const stub = requests([Response.json({
      machine_logins: [
        {
          harness: "codex",
          providerIds: ["codex-app-server", "openai"],
          state: "signed_in",
          email: "person@example.com",
          plan: "pro",
          usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
          accessToken: "must-not-retain",
        },
        { providerIds: ["cursor-acp"], state: "signed_in" },
      ],
    })])

    await expect(loadMachineLogins({ request: stub.request })).resolves.toEqual([{
      harness: "codex",
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in",
      email: "person@example.com",
      plan: "pro",
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
    }])
    expect(JSON.stringify(await stub.calls)).not.toContain("must-not-retain")
    expect(stub.calls[0].input).toMatchObject({ action: "machine-logins" })
  })

  test("a host that runs no harness reports no login rather than failing the read", async () => {
    const stub = requests([new Response("{}", { status: 501 })])

    await expect(loadMachineLogins({ request: stub.request })).resolves.toEqual([])
  })

  test("one harness's Check asks about that harness alone", async () => {
    const stub = requests([Response.json({ machine_logins: [] })])

    await loadMachineLogins({ harness: "claude", request: stub.request })

    expect(stub.calls[0].input).toMatchObject({ action: "machine-logins", harness: "claude" })
  })

  test("choosing this computer's login posts the providers to withdraw the mark from", async () => {
    const stub = requests([Response.json({ credentials: [], cleared: ["sdk"] })])

    await useMachineLogin({ providerIds: ["claude-acp", "claude-sdk"], request: stub.request })

    expect(stub.calls[0].input).toMatchObject({ action: "activate" })
    const body = stub.calls[0].init?.body
    expect(JSON.parse(typeof body === "string" ? body : ""))
      .toEqual({ machine_login: { provider_ids: ["claude-acp", "claude-sdk"] } })
  })

  test("saves only selected discovered providers, then verifies each saved credential", async () => {
    const stub = requests([
      Response.json({ saved: [{ credential_id: "cred-anthropic", provider_id: "anthropic" }] }),
      Response.json({ result: "ok" }),
    ])

    await expect(saveDiscoveredAIConnections({
      discoveryId: "discovery-1",
      items: [{ providerId: "anthropic", scope: "local" }],
      request: stub.request,
    })).resolves.toEqual([{ credentialId: "cred-anthropic", providerId: "anthropic", result: "ok" }])
    expect(requestJson(stub.calls[0].init)).toEqual({
      discovery_id: "discovery-1",
      items: [{ provider_id: "anthropic", scope: "local" }],
    })
    expect(stub.calls[1].input).toMatchObject({ credentialId: "cred-anthropic", action: "verify" })
  })

  test.each(["auth_failed", "no_billing"] as const)("returns typed %s failures after API-key save", async (result) => {
    const stub = requests([
      Response.json({ credential: { id: "cred-1", provider_id: "anthropic" } }),
      Response.json({ result }),
    ])

    await expect(connectAIKey({
      providerId: "anthropic",
      providerName: "Anthropic",
      apiKey: "sk-test",
      scope: "local",
      request: stub.request,
    })).resolves.toEqual({ credentialId: "cred-1", providerId: "anthropic", result })
    expect(stub.calls[1].input).toMatchObject({ credentialId: "cred-1", action: "verify" })
  })

  test("re-verifies credentials created by a provider OAuth flow", async () => {
    const stub = requests([
      Response.json({ credentials: [
        { id: "cred-anthropic", provider_id: "anthropic" },
        { id: "cred-openai", provider_id: "openai" },
      ] }),
      Response.json({ result: "ok" }),
    ])

    await expect(verifyProviderAIConnections({ providerId: "openai", request: stub.request })).resolves.toEqual([
      { credentialId: "cred-openai", providerId: "openai", result: "ok" },
    ])
    expect(stub.calls[1].input).toMatchObject({ credentialId: "cred-openai", action: "verify" })
  })

  test("keeps the plan's usage windows a verification reports, and drops malformed ones", async () => {
    const stub = requests([
      Response.json({ credentials: [{ id: "cred-codex", provider_id: "codex-app-server" }] }),
      Response.json({
        result: "ok",
        usage: [
          { window: "session", usedPercent: 12, resetsAt: 1_757_600_000_000 },
          { window: "weekly", usedPercent: 40 },
          { window: "broken" },
        ],
      }),
    ])

    await expect(verifyProviderAIConnections({ providerId: "codex-app-server", request: stub.request })).resolves.toEqual([{
      credentialId: "cred-codex",
      providerId: "codex-app-server",
      result: "ok",
      usage: [
        { window: "session", usedPercent: 12, resetsAt: 1_757_600_000_000 },
        { window: "weekly", usedPercent: 40, resetsAt: null },
      ],
    }])
  })
})

/** The JSON a fetch call carried. A non-string body is not something we send. */
function requestJson(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}
