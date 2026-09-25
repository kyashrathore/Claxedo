import { expect, test } from "bun:test"
import { ownerMayUseMachineLogin, providerPlaceholder, selectedProviderProjection } from "./credentials"

test("Pi machine login follows the session owner on desktop or loopback only", () => {
  const base = { placement: "desktop" as const, machineOwnerUserId: "owner", canUseOwnLogin: true }
  expect(ownerMayUseMachineLogin({ kind: "machine-owner" }, base)).toBe(true)
  expect(ownerMayUseMachineLogin({ kind: "person", userId: "owner" }, base)).toBe(true)
  expect(ownerMayUseMachineLogin({ kind: "machine-owner" }, { ...base, placement: "loopback" })).toBe(true)
  expect(ownerMayUseMachineLogin({ kind: "person", userId: "member" }, base)).toBe(false)
  expect(ownerMayUseMachineLogin({ kind: "machine-owner" }, { ...base, placement: "cloud" })).toBe(false)
  expect(ownerMayUseMachineLogin({ kind: "machine-owner" }, { ...base, placement: "self-hosted" })).toBe(false)
  expect(ownerMayUseMachineLogin({ kind: "machine-owner" }, { ...base, canUseOwnLogin: false })).toBe(false)
})

test("the first configured provider yields its placeholder binding", () => {
  const binding = { baseUrl: "https://provider.example", apiPath: "/v1", placeholder: "placeholder", authMode: "api-key" as const }
  const credentials = { providers: { second: binding }, secrets: {}, leaseGeneration: "g1" }
  const selected = selectedProviderProjection(credentials, ["first", "second"])
  expect(selected).toBe(binding)
  expect(providerPlaceholder(selected!)).toEqual({ baseURL: "https://provider.example/v1", apiKey: "placeholder" })
})
