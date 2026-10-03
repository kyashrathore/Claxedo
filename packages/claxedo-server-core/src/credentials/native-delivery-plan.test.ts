import { describe, expect, test } from "vitest"
import { directProviderDeliveriesFromRepository } from "./native-delivery-plan"
import type { CredentialMetadata } from "./types"

function credential(input: Partial<CredentialMetadata> & Pick<CredentialMetadata, "id" | "provider_id" | "kind">): CredentialMetadata {
  return { owner: "user_owner", source: "managed", status: "available", created_at: 1, updated_at: 1, revision: 1, incarnation: "i1", ...input } as CredentialMetadata
}

const secrets: Record<string, string> = {
  plan: JSON.stringify({ access_token: "chatgpt-access", account_id: "acct_1" }),
  key: "sk-ant-api03-owner",
  subscription: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-owner" } }),
  other: "sk-ant-api03-other-person",
}

function deliver(selected: CredentialMetadata[]) {
  return directProviderDeliveriesFromRepository({
    owner: "user_owner",
    machineOwnerUserId: "user_owner",
    selections: {},
    selected: selected.map((row) => ({ credential: row, ...(row.status !== "available" ? { unavailable: row.status } : {}) })),
    readSecret: async (row) => secrets[row.id],
  })
}

describe("direct provider delivery", () => {
  test("hands a ChatGPT plan login over whole, though a provider edge could not deliver it", async () => {
    const [row] = await deliver([credential({ id: "plan", provider_id: "codex-app-server", kind: "oauth_token", expires_at: 9_000_000_000_000, label: "Plan" })])
    expect(row).toEqual({
      providerId: "codex-app-server",
      credentialId: "plan",
      direct: {
        delivery: "direct",
        baseUrl: "https://chatgpt.com",
        apiPath: expect.stringMatching(/^\//),
        secret: "chatgpt-access",
        authKind: "subscription",
        expiresAt: 9_000_000_000_000,
        account: { credentialId: "plan", providerId: "codex-app-server", label: "Plan" },
      },
    })
  })

  test("spends only the owner's accounts and one account per vendor host, the most recently marked", async () => {
    const rows = await deliver([
      credential({ id: "key", provider_id: "claude-sdk", kind: "api_key", activated_at: 10 }),
      credential({ id: "subscription", provider_id: "anthropic", kind: "oauth_token", activated_at: 20 }),
      credential({ id: "other", provider_id: "openai", kind: "api_key", owner: "user_other" }),
    ])
    expect(rows).toEqual([
      expect.objectContaining({ providerId: "anthropic", direct: expect.objectContaining({ secret: "sk-ant-oat01-owner", authKind: "subscription" }) }),
      { providerId: "claude-sdk", credentialId: "key", unavailable: "duplicate_destination_host: api.anthropic.com is delivered for anthropic, marked more recently" },
    ])
  })

  test("names why an account cannot be handed over instead of dropping it", async () => {
    expect(await deliver([credential({ id: "key", provider_id: "anthropic", kind: "api_key", status: "revoked" })]))
      .toEqual([{ providerId: "anthropic", credentialId: "key", unavailable: "revoked" }])
    expect(await deliver([credential({ id: "missing", provider_id: "anthropic", kind: "api_key" })]))
      .toEqual([{ providerId: "anthropic", credentialId: "missing", unavailable: "unreadable_secret" }])
  })
})
