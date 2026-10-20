/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { AccountSpend, AccountSpendPayer } from "@/server"
import { accountSpendRequest, spendRow, spendScope, spendScopes, spendTokens } from "./account-spend"

const totals = { turnCount: 3, input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 }
const cost = { estimatedUsd: 0.2, pricedTokens: 15, unpricedTokens: 0 }
const spend = (payer: AccountSpendPayer): AccountSpend => ({ payer, totals, cost })

describe("spend per account scopes", () => {
  test("an owner or admin chooses between their own accounts and the organization accounts; a member is offered their own alone", () => {
    expect(spendScopes(true)).toEqual(["mine", "org"])
    expect(spendScopes(false)).toEqual(["mine"])
  })

  test("a member never reads the organization accounts, even when they were chosen before the fact said otherwise", () => {
    expect(spendScope("org", true)).toBe("org")
    expect(spendScope("org", false)).toBe("mine")
    expect(spendScope("mine", true)).toBe("mine")
  })

  test("reads the chosen range of local days through today", () => {
    const now = new Date(2026, 9, 17, 9, 30).getTime()
    const request = accountSpendRequest(7, "org", now)
    expect(request.scope).toBe("org")
    expect(new Date(request.since)).toEqual(new Date(2026, 9, 11, 0, 0, 0, 0))
    expect(new Date(request.until)).toEqual(new Date(2026, 9, 17, 23, 59, 59, 999))
  })
})

describe("spend per account rows", () => {
  test("an own plan or API key and an organization account keep their name and vendor, and say which kind they are", () => {
    expect(spendRow(spend({ kind: "own", accountId: "cred_plan", access: "plan", label: "Work Claude", providerId: "anthropic" }))).toMatchObject({ id: "cred_plan", kind: "plan", label: "Work Claude", vendor: "Anthropic" })
    expect(spendRow(spend({ kind: "own", accountId: "cred_key", access: "apiKey", providerId: "openai" }))).toMatchObject({ id: "cred_key", kind: "apiKey", vendor: "OpenAI" })
    expect(spendRow(spend({ kind: "team", accountId: "cred_team", access: "apiKey", label: "Acme Cursor", providerId: "cursor", members: [] }))).toMatchObject({ id: "cred_team", kind: "teamKey", label: "Acme Cursor", vendor: "Cursor" })
    expect(spendRow(spend({ kind: "own", accountId: "cred_claude", access: "plan", providerId: "claude-sdk" }))).toMatchObject({ kind: "plan", vendor: "Anthropic" })
  })

  test("an organization account carries its spend per member, and no other account does", () => {
    const members = [{ memberId: "user_alice", member: { kind: "named", name: "Alice Liddell" }, totals, cost }] as const
    expect(spendRow(spend({ kind: "team", accountId: "cred_team", access: "apiKey", members }))).toMatchObject({ kind: "teamKey", members })
    expect(spendRow(spend({ kind: "own", accountId: "cred_key", access: "apiKey" }))).not.toHaveProperty("members")
  })

  test("a deleted account keeps its kind with no name or vendor, so the row is still told apart by its id", () => {
    const row = spendRow(spend({ kind: "own", accountId: "cred_gone", access: "plan" }))
    expect(row).toEqual({ id: "cred_gone", kind: "plan", totals, cost })
  })

  test("another member's account, the machine's own login, an account no longer available and an unrecorded payer carry nothing of an account", () => {
    for (const kind of ["otherMember", "machine", "unresolved", "unreported"] as const) {
      expect(spendRow(spend({ kind }))).toEqual({ id: kind, kind, totals, cost })
    }
  })

  test("tokens are unknown only when every turn reported none, never a measured zero", () => {
    expect(spendTokens(spendRow(spend({ kind: "machine" })))).toBe(15)
    const unreported = { payer: { kind: "unreported" }, totals: { ...totals, input: 0, output: 0, unavailableTurnCount: 3 }, cost: { estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 0 } } satisfies AccountSpend
    expect(spendTokens(spendRow(unreported))).toBeUndefined()
    expect(spendTokens(spendRow({ ...unreported, totals: { ...unreported.totals, unavailableTurnCount: 2 } }))).toBe(0)
  })
})
