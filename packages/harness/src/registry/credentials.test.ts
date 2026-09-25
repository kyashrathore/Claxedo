import { expect, test } from "bun:test"
import type { ProviderBinding, ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../contract/projection"
import { CredentialSelectionError, selectTurnCredentials, type CredentialSelectionInput } from "./credentials"

const ownerLogin: ResolvedCredentials = { providers: {}, secrets: {}, leaseGeneration: "owner-pi" }
const machineBinding: ProviderBinding = { baseUrl: "https://machine.example", placeholder: "machine", authMode: "api-key" }
const ownerBinding: ProviderBinding = { baseUrl: "https://owner.example", placeholder: "owner", authMode: "api-key" }
const memberBinding: ProviderBinding = { baseUrl: "https://member.example", placeholder: "member", authMode: "api-key" }
const machineCredentials = {
  anthropic: { projection: machineBinding, secrets: {} },
  openai: { projection: machineBinding, secrets: {} },
}
const direct = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const grant = { actor: { kind: "person" as const, userId: "owner" }, via: "owner-grant" as const, reissued: false }
const ownerRelay = { actor: { kind: "person" as const, userId: "owner" }, via: "relay" as const, reissued: false }
const memberShare = { actor: { kind: "person" as const, userId: "member" }, via: "relay" as const, reissued: false }
const selectedAccounts = {
  owner: { anthropic: { projection: ownerBinding, secrets: {} } },
  member: { anthropic: { projection: memberBinding, secrets: {} } },
}
const providerProfile = { kind: "providers" as const, providerIds: ["anthropic", "openai"], selectedAccounts, machineCredentials, leaseGeneration: "turn-1" }
const providerInput: CredentialSelectionInput = {
  origin: direct, placement: "desktop", machineOwnerUserId: "owner", canUseOwnLogin: true,
  profile: providerProfile,
}

function unavailable(value: unknown): asserts value is ProviderUnavailable {
  expect(value).toEqual({ unavailable: true, reason: "No selected account for this provider" })
}

test("owner selection wins and unselected providers use machine credentials only locally", () => {
  const credentials = selectTurnCredentials(providerInput)
  expect(credentials.providers.anthropic).toBe(ownerBinding)
  expect(credentials.providers.openai).toBe(machineBinding)
  expect(selectTurnCredentials({ ...providerInput, origin: grant }).providers.anthropic).toBe(ownerBinding)
  expect(selectTurnCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: {} } }).providers.anthropic).toBe(machineBinding)
})

test("relay owner and shared member use only their own selected account", () => {
  const owner = selectTurnCredentials({ ...providerInput, origin: ownerRelay })
  expect(owner.providers.anthropic).toBe(ownerBinding)
  unavailable(owner.providers.openai)
  const member = selectTurnCredentials({ ...providerInput, origin: memberShare })
  expect(member.providers.anthropic).toBe(memberBinding)
  unavailable(member.providers.openai)
  const missing = selectTurnCredentials({ ...providerInput, origin: memberShare, profile: { ...providerProfile, selectedAccounts: {} } })
  unavailable(missing.providers.anthropic)
})

test("cloud owner has no machine fallback and a queued reissue rechecks its sender", () => {
  const cloud = selectTurnCredentials({ ...providerInput, placement: "cloud" })
  expect(cloud.providers.anthropic).toBe(ownerBinding)
  unavailable(cloud.providers.openai)
  const reissued = selectTurnCredentials({ ...providerInput, origin: { ...memberShare, reissued: true } })
  expect(reissued.providers.anthropic).toBe(memberBinding)
  unavailable(reissued.providers.openai)
})

test("selected provider secrets cannot overwrite another provider lease", () => {
  const conflicting = {
    owner: {
      anthropic: { projection: ownerBinding, secrets: { TOKEN: "anthropic" } },
      openai: { projection: ownerBinding, secrets: { TOKEN: "openai" } },
    },
  }
  expect(() => selectTurnCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: conflicting } })).toThrow(CredentialSelectionError)
})

test("machine fallback injects only its available provider secrets", () => {
  const selected = { owner: { anthropic: { projection: ownerBinding, secrets: { ANTHROPIC_API_KEY: "selected" } } } }
  const machine = {
    anthropic: { projection: machineBinding, secrets: { ANTHROPIC_API_KEY: "machine" } },
    openai: { projection: machineBinding, secrets: { OPENAI_API_KEY: "machine-openai" } },
  }
  expect(selectTurnCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: selected, machineCredentials: machine } }).secrets)
    .toEqual({ ANTHROPIC_API_KEY: "selected", OPENAI_API_KEY: "machine-openai" })
  expect(selectTurnCredentials({ ...providerInput, profile: { ...providerProfile, selectedAccounts: {}, machineCredentials: {
    anthropic: { projection: { unavailable: true, reason: "missing" }, secrets: { ANTHROPIC_API_KEY: "ambient" } },
    openai: machine.openai,
  } } }).secrets).toEqual({ OPENAI_API_KEY: "machine-openai" })
})

test("Pi owner profile is limited to direct or own-grant local turns", () => {
  const base: CredentialSelectionInput = {
    origin: direct, placement: "desktop", machineOwnerUserId: "owner", canUseOwnLogin: true,
    profile: { kind: "pi-rpc", sessionProfile: "owner-login", ownerLogin, brokeredCredentials: ownerLogin },
  }
  expect(selectTurnCredentials(base)).toBe(ownerLogin)
  expect(selectTurnCredentials({ ...base, origin: grant })).toBe(ownerLogin)
  for (const input of [
    { ...base, origin: memberShare },
    { ...base, origin: { ...memberShare, reissued: true } },
    { ...base, origin: ownerRelay },
    { ...base, placement: "cloud" as const },
  ]) {
    expect(() => selectTurnCredentials(input)).toThrow(CredentialSelectionError)
    try { selectTurnCredentials(input) } catch (error) { expect((error as CredentialSelectionError).code).toBe("origin_mismatch") }
  }
})
