/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId } from "../ids"
import { accountSpendFromWire, machineTimeFromWire } from "./usage"

const rate = { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 }
const boat = { provider: "boat", label: "Boat", meter: "Boat bills per second while a sandbox runs.", source: { url: "https://docs.boat.dev/pricing", readOn: "2026-10-12" } }

test("a machine-time answer keeps its period, totals, priced and unpriced workspace rows and the providers' billing, and refuses one missing a number", () => {
  const body = {
    since: 1,
    until: 2,
    activeMs: 600_000,
    running: 1,
    workspaces: [
      { workspaceId: "ws_a", projectId: "prj_1", name: "Checkout", branch: "main", provider: "boat", providerLabel: "Boat", machineClass: "small", activeMs: 600_000, runningSince: 1, lastStoppedAt: 0, rate, costUsd: 0.003 },
      { workspaceId: "ws_b", name: "ws_b", provider: "modal", providerLabel: "Modal", machineClass: null, activeMs: 60_000 },
    ],
    providers: [{ ...boat, excludes: "nothing" }],
    extra: "x",
  }
  expect(machineTimeFromWire(body)).toEqual({
    since: 1,
    until: 2,
    activeMs: 600_000,
    running: 1,
    workspaces: [
      { id: placementId("ws_a"), projectId: projectId("prj_1"), name: "Checkout", branch: "main", provider: "boat", providerLabel: "Boat", machineClass: "small", activeMs: 600_000, runningSince: 1, lastStoppedAt: 0, rate, costUsd: 0.003 },
      { id: placementId("ws_b"), provider: "modal", providerLabel: "Modal", activeMs: 60_000 },
    ],
    providers: [{ ...boat, excludes: "nothing" }],
  })
  expect(() => machineTimeFromWire({ since: 1, until: 2, running: 0, workspaces: [], providers: [] })).toThrow()
  expect(() => machineTimeFromWire({ since: 1, until: 2, activeMs: "600000", running: 0, workspaces: [], providers: [] })).toThrow()
  expect(() => machineTimeFromWire({ since: 1, until: 2, activeMs: 0, running: 0 })).toThrow()
  expect(() => machineTimeFromWire({ ...body, workspaces: [{ workspaceId: "ws_a", provider: "boat", providerLabel: "Boat", activeMs: 1, rate }] })).toThrow()
  expect(() => machineTimeFromWire({ ...body, providers: [{ provider: "boat", label: "Boat" }] })).toThrow()
  expect(() => machineTimeFromWire(null)).toThrow()
})

const spent = { turnCount: 2, input: 100, output: 20, reasoning: 0, cacheRead: 300, cacheWrite: 0, unknownCategories: 0, estimatedUsd: 0.01, pricedTokens: 420, unpricedTokens: 0 }
const totals = { turnCount: 2, input: 100, output: 20, reasoning: 0, cacheRead: 300, cacheWrite: 0, unknownCategories: 0 }
const cost = { estimatedUsd: 0.01, pricedTokens: 420, unpricedTokens: 0 }

test("spend per credential names each payer in the app's terms: an own or team account by id, access, label and vendor, and the payers that carry nothing of an account", () => {
  const body = {
    since: 1,
    until: 2,
    scope: "mine",
    credentials: [
      { ...spent, source: "personal", credentialId: "cred_plan", kind: "subscription_session", label: "Work Claude", providerId: "anthropic" },
      { ...spent, source: "personal", credentialId: "cred_token", kind: "oauth_token" },
      { ...spent, source: "org", credentialId: "cred_team", kind: "api_key", label: "Team OpenAI", providerId: "openai" },
      { ...spent, source: "other_member", partialTurnCount: 1 },
      { ...spent, source: "machine" },
      { ...spent, source: "unresolved" },
      { ...spent, source: "unreported", unavailableTurnCount: 2 },
    ],
  }
  expect(accountSpendFromWire(body)).toEqual({
    since: 1,
    until: 2,
    scope: "mine",
    accounts: [
      { payer: { kind: "own", accountId: "cred_plan", access: "plan", label: "Work Claude", providerId: "anthropic" }, totals, cost },
      { payer: { kind: "own", accountId: "cred_token", access: "plan" }, totals, cost },
      { payer: { kind: "team", accountId: "cred_team", access: "apiKey", label: "Team OpenAI", providerId: "openai" }, totals, cost },
      { payer: { kind: "otherMember" }, totals: { ...totals, partialTurnCount: 1 }, cost },
      { payer: { kind: "machine" }, totals, cost },
      { payer: { kind: "unresolved" }, totals, cost },
      { payer: { kind: "unreported" }, totals: { ...totals, unavailableTurnCount: 2 }, cost },
    ],
  })
})

test("spend per credential is refused when a payer, an account's id or kind, or a figure is not what the contract says", () => {
  const answer = (credential: Record<string, unknown>, scope: unknown = "org") => ({ since: 1, until: 2, scope, credentials: [credential] })
  expect(accountSpendFromWire(answer({ ...spent, source: "org", credentialId: "cred_team", kind: "api_key" })).scope).toBe("org")
  expect(() => accountSpendFromWire(answer({ ...spent, source: "org", credentialId: "cred_team", kind: "api_key" }, "all"))).toThrow()
  expect(() => accountSpendFromWire(answer({ ...spent, source: "someone" }))).toThrow()
  expect(() => accountSpendFromWire(answer({ ...spent, source: "personal", kind: "api_key" }))).toThrow()
  expect(() => accountSpendFromWire(answer({ ...spent, source: "personal", credentialId: "cred_a", kind: "password" }))).toThrow()
  expect(() => accountSpendFromWire(answer({ ...spent, source: "machine", turnCount: "2" }))).toThrow()
  expect(() => accountSpendFromWire(answer({ ...spent, source: "machine", estimatedUsd: undefined }))).toThrow()
  expect(() => accountSpendFromWire({ since: 1, until: 2, scope: "mine" })).toThrow()
  expect(() => accountSpendFromWire(null)).toThrow()
})
