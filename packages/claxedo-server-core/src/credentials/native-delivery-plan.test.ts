import { describe, expect, test } from "vitest"
import { directProviderDeliveriesFromRepository, nativeProviderDeliveriesFromRepository, type HarnessCredentialBroker } from "./native-delivery-plan"
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

describe("native provider delivery through the plane's broker", () => {
  const cursor = "key_user_01234567890123456789012345678901234567890123456789012345678901234567"
  function recordingBroker() {
    const bound: string[] = []
    const broker: HarnessCredentialBroker = {
      async bind(row, destination) {
        bound.push(row.id)
        return { baseUrl: `https://api.claxedo.test/bindings/${row.id}`, placeholder: `placeholder-${row.id}`, authMode: destination.injection.header === "Authorization" ? "bearer" : "api-key", apiPath: destination.apiPath, expiresAt: 10_000 }
      },
    }
    return { broker, bound }
  }
  const walk = (rows: CredentialMetadata[], input: { secretBrokering: "native" | "none"; broker?: HarnessCredentialBroker }) =>
    nativeProviderDeliveriesFromRepository({
      owner: "user_owner",
      machineOwnerUserId: "user_owner",
      selections: {},
      selected: rows.map((row) => ({ credential: row })),
      readSecret: async (row) => ({ ...secrets, cursor })[row.id],
      ...input,
    })

  test("a driver without an edge hands the harness a binding on the plane and no edge secret, and a plan login still travels direct", async () => {
    const { broker, bound } = recordingBroker()
    const rows = await walk([
      credential({ id: "key", provider_id: "anthropic", kind: "api_key" }),
      credential({ id: "plan", provider_id: "codex-app-server", kind: "oauth_token", expires_at: 9_000_000_000_000 }),
    ], { secretBrokering: "none", broker })
    expect(rows).toEqual([
      { providerId: "anthropic", credentialId: "key", userId: "user_owner", revision: 1, projection: {
        baseUrl: "https://api.claxedo.test/bindings/key", placeholder: "placeholder-key", authMode: "api-key", apiPath: "/v1", expiresAt: 10_000,
      } },
      expect.objectContaining({ providerId: "codex-app-server", direct: expect.objectContaining({ authKind: "subscription" }) }),
    ])
    expect(rows[0]).not.toHaveProperty("secret")
    expect(bound).toEqual(["key"])
  })

  test("a driver with its own edge never meets the broker", async () => {
    const { broker, bound } = recordingBroker()
    const [row] = await walk([credential({ id: "key", provider_id: "anthropic", kind: "api_key" })], { secretBrokering: "native", broker })
    expect(row).toMatchObject({ secret: { value: "sk-ant-api03-owner", hosts: ["api.anthropic.com"] }, projection: { placeholderEnv: expect.stringMatching(/^CLAXEDO_PROVIDER_ANTHROPIC_/) } })
    expect(bound).toEqual([])
  })

  test("a vendor that exchanges the key for a session stays refused, and so does everything without a broker", async () => {
    const { broker, bound } = recordingBroker()
    expect(await walk([credential({ id: "cursor", provider_id: "cursor-sdk", kind: "api_key" })], { secretBrokering: "none", broker }))
      .toEqual([expect.objectContaining({ providerId: "cursor-sdk", projection: { unavailable: true, reason: "harness_needs_brokering" } })])
    expect(bound).toEqual([])
    expect(await walk([credential({ id: "key", provider_id: "anthropic", kind: "api_key" })], { secretBrokering: "none" }))
      .toEqual([expect.objectContaining({ projection: { unavailable: true, reason: "harness_needs_brokering" } })])
  })
})
