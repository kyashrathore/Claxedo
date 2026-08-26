import { describe, expect, test } from "bun:test"
import {
  connectAIKey,
  discoverAIConnections,
  saveDiscoveredAIConnections,
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
    const stub = requests([
      Response.json({
        discovery_id: "discovery-1",
        items: [
          {
            provider_id: "anthropic",
            kind: "oauth_token",
            label: "Claude subscription",
            account_id: "ac…12",
            origin: "macOS Keychain",
            fresh_until: 123,
            secret: "must-not-retain",
          },
        ],
      }),
    ])

    await expect(discoverAIConnections({ request: stub.request })).resolves.toEqual({
      discoveryId: "discovery-1",
      items: [
        {
          providerId: "anthropic",
          kind: "oauth_token",
          label: "Claude subscription",
          accountId: "ac…12",
          origin: "macOS Keychain",
          freshUntil: 123,
        },
      ],
    })
    expect(JSON.stringify(await stub.calls)).not.toContain("must-not-retain")
    expect(stub.calls[0].input).toMatchObject({ action: "discover" })
  })

  test("saves only selected discovered providers, then verifies each saved credential", async () => {
    const stub = requests([
      Response.json({ saved: [{ credential_id: "cred-anthropic", provider_id: "anthropic" }] }),
      Response.json({ result: "ok" }),
    ])

    await expect(
      saveDiscoveredAIConnections({
        discoveryId: "discovery-1",
        items: [{ providerId: "anthropic", scope: "local" }],
        request: stub.request,
      }),
    ).resolves.toEqual([{ credentialId: "cred-anthropic", providerId: "anthropic", result: "ok" }])
    expect(JSON.parse(String(stub.calls[0].init?.body))).toEqual({
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

    await expect(
      connectAIKey({
        providerId: "anthropic",
        providerName: "Anthropic",
        apiKey: "sk-test",
        scope: "local",
        request: stub.request,
      }),
    ).resolves.toEqual({ credentialId: "cred-1", providerId: "anthropic", result })
    expect(stub.calls[1].input).toMatchObject({ credentialId: "cred-1", action: "verify" })
  })

  test("re-verifies credentials created by a provider OAuth flow", async () => {
    const stub = requests([
      Response.json({
        credentials: [
          { id: "cred-anthropic", provider_id: "anthropic" },
          { id: "cred-openai", provider_id: "openai" },
        ],
      }),
      Response.json({ result: "ok" }),
    ])

    await expect(verifyProviderAIConnections({ providerId: "openai", request: stub.request })).resolves.toEqual([
      { credentialId: "cred-openai", providerId: "openai", result: "ok" },
    ])
    expect(stub.calls[1].input).toMatchObject({ credentialId: "cred-openai", action: "verify" })
  })
})
