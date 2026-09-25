import { expect, test } from "bun:test"
import type { ProviderBinding, ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import { CredentialSelectionError, selectSessionCredentials, type CredentialSelectionInput } from "./credentials"

const machineBinding: ProviderBinding = { baseUrl: "https://machine.example", placeholder: "machine", authMode: "api-key" }
const ownerBinding: ProviderBinding = { baseUrl: "https://owner.example", placeholder: "owner", authMode: "api-key" }
const memberBinding: ProviderBinding = { baseUrl: "https://member.example", placeholder: "member", authMode: "api-key" }
const machineCredentials = {
  anthropic: { projection: machineBinding, secrets: {} },
  openai: { projection: machineBinding, secrets: {} },
}
const machineOwner = { kind: "machine-owner" as const }
const member = { kind: "person" as const, userId: "member" }
const selectedAccounts = {
  owner: { anthropic: { projection: ownerBinding, secrets: {} } },
  member: { anthropic: { projection: memberBinding, secrets: {} } },
}
const providerProfile = { kind: "providers" as const, providerIds: ["anthropic", "openai"], selectedAccounts, machineCredentials, leaseGeneration: "turn-1" }
const providerInput: CredentialSelectionInput = {
  owner: machineOwner, placement: "desktop", machineOwnerUserId: "owner", canUseOwnLogin: true,
  profile: providerProfile,
}

function unavailable(value: unknown): asserts value is ProviderUnavailable {
  expect(value).toEqual({ unavailable: true, reason: "No selected account for this provider" })
}

test("owner selection wins and unselected providers use machine credentials only locally", () => {
  const credentials = selectSessionCredentials(providerInput)
  expect(credentials.providers.anthropic).toBe(ownerBinding)
  expect(credentials.providers.openai).toBe(machineBinding)
  expect(selectSessionCredentials({ ...providerInput, owner: { kind: "person", userId: "owner" } }).providers.anthropic).toBe(ownerBinding)
  expect(selectSessionCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: {} } }).providers.anthropic).toBe(machineBinding)
})

test("a session owned by a member selects only the member's accounts", () => {
  const owner = selectSessionCredentials({ ...providerInput, owner: { kind: "person", userId: "owner" } })
  expect(owner.providers.anthropic).toBe(ownerBinding)
  expect(owner.providers.openai).toBe(machineBinding)
  const memberCredentials = selectSessionCredentials({ ...providerInput, owner: member })
  expect(memberCredentials.providers.anthropic).toBe(memberBinding)
  unavailable(memberCredentials.providers.openai)
  const missing = selectSessionCredentials({ ...providerInput, owner: member, profile: { ...providerProfile, selectedAccounts: {} } })
  unavailable(missing.providers.anthropic)
})

test("cloud owner has no machine fallback", () => {
  const cloud = selectSessionCredentials({ ...providerInput, placement: "cloud" })
  expect(cloud.providers.anthropic).toBe(ownerBinding)
  unavailable(cloud.providers.openai)
})

test("selected provider secrets cannot overwrite another provider lease", () => {
  const conflicting = {
    owner: {
      anthropic: { projection: ownerBinding, secrets: { TOKEN: "anthropic" } },
      openai: { projection: ownerBinding, secrets: { TOKEN: "openai" } },
    },
  }
  expect(() => selectSessionCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: conflicting } })).toThrow(CredentialSelectionError)
})

test("machine fallback injects only its available provider secrets", () => {
  const selected = { owner: { anthropic: { projection: ownerBinding, secrets: { ANTHROPIC_API_KEY: "selected" } } } }
  const machine = {
    anthropic: { projection: machineBinding, secrets: { ANTHROPIC_API_KEY: "machine" } },
    openai: { projection: machineBinding, secrets: { OPENAI_API_KEY: "machine-openai" } },
  }
  expect(selectSessionCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: selected, machineCredentials: machine } }).secrets)
    .toEqual({ ANTHROPIC_API_KEY: "selected", OPENAI_API_KEY: "machine-openai" })
  expect(selectSessionCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: {}, machineCredentials: {
    anthropic: { projection: { unavailable: true, reason: "missing" }, secrets: { ANTHROPIC_API_KEY: "ambient" } },
    openai: machine.openai,
  } } }).secrets).toEqual({ OPENAI_API_KEY: "machine-openai" })
})
