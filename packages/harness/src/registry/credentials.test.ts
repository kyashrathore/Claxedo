import { expect, test } from "bun:test"
import type { ProviderBinding } from "@claxedo/agent-runtime-contract"
import { CredentialSelectionError, selectSessionCredentials, type CredentialSelectionInput } from "./credentials"

const binding = (person: string): ProviderBinding => ({ baseUrl: `https://${person}.example`, placeholder: person, authMode: "api-key" })
const snapshot: CredentialSelectionInput = {
  machineOwnerUserId: "A", placement: "desktop", canUseOwnLogin: true, leaseGeneration: "lease",
  accounts: { A: { openai: binding("A") }, B: { openai: binding("B") } }, providerIds: ["codex-app-server", "openai"],
}

test("each session selects its owner's account without mixing another person's providers", () => {
  for (const userId of ["A", "B"]) {
    expect(selectSessionCredentials(snapshot, { kind: "person", userId })).toEqual({
      accountOwner: userId, providers: { openai: binding(userId) }, secrets: {}, leaseGeneration: "lease", machineLoginAllowed: userId === "A",
    })
  }
  expect(selectSessionCredentials(snapshot, { kind: "machine-owner" })).toMatchObject({ accountOwner: "A", providers: snapshot.accounts.A })
})

test("only the machine owner may use a local login when no account is selected", () => {
  const empty = { ...snapshot, accounts: {} }
  expect(selectSessionCredentials(empty, { kind: "person", userId: "A" }).machineLoginAllowed).toBe(true)
  expect(() => selectSessionCredentials(empty, { kind: "person", userId: "B" })).toThrow(CredentialSelectionError)
  for (const policy of [{ placement: "cloud" as const }, { placement: "self-hosted" as const }, { canUseOwnLogin: false }]) {
    expect(() => selectSessionCredentials({ ...empty, ...policy }, { kind: "machine-owner" })).toThrow(CredentialSelectionError)
  }
})

test("an unrelated binding cannot authorize a provider and explicit unavailability never uses the machine login", () => {
  expect(() => selectSessionCredentials({ ...snapshot, providerIds: ["anthropic"] }, { kind: "person", userId: "B" }))
    .toThrow(CredentialSelectionError)
  expect(() => selectSessionCredentials({ ...snapshot, accounts: { A: { openai: { unavailable: true, reason: "expired" } } } },
    { kind: "machine-owner" })).toThrow("expired")
})

test("a usable binding wins over an unusable one earlier in the harness's provider order", () => {
  const mixed = { ...snapshot, accounts: { B: { "codex-app-server": { unavailable: true as const, reason: "revoked" }, openai: binding("B") } } }
  expect(selectSessionCredentials(mixed, { kind: "person", userId: "B" }).providers.openai).toEqual(binding("B"))
})

test("a harness that spends no provider account is never refused for lacking one", () => {
  const { providerIds: _providerIds, ...connection } = snapshot
  const cloud = { ...connection, placement: "cloud" as const, canUseOwnLogin: false }
  expect(selectSessionCredentials(cloud, { kind: "person", userId: "C" })).toEqual({
    accountOwner: "C", providers: {}, secrets: {}, leaseGeneration: "lease", machineLoginAllowed: false,
  })
  const withdrawn = { ...cloud, accounts: { A: { openai: { unavailable: true as const, reason: "expired" } } } }
  expect(selectSessionCredentials(withdrawn, { kind: "person", userId: "A" }).providers).toEqual(withdrawn.accounts.A)
})

test("an owner holding only direct credentials is selected with exactly their own direct rows", () => {
  const key = { delivery: "direct" as const, baseUrl: "https://api.openai.com", secret: "sk-B", authKind: "api-key" as const }
  const direct = { ...snapshot, accounts: {}, direct: { B: { openai: key }, C: { anthropic: { ...key, secret: "sk-C" } } } }
  expect(selectSessionCredentials(direct, { kind: "person", userId: "B" })).toEqual({
    accountOwner: "B", providers: {}, direct: { openai: key }, secrets: {}, leaseGeneration: "lease", machineLoginAllowed: false,
  })
  expect(() => selectSessionCredentials(direct, { kind: "person", userId: "C" })).toThrow(CredentialSelectionError)
})
