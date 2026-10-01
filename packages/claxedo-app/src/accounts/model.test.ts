/// <reference types="bun" />
import type { AccountSource } from "@claxedo/account-contract/vocabulary"
import { expect, test } from "bun:test"
import type { Account } from "@/server"
import { storedAccountWords, teamAccountWords } from "./account-words"
import type { AccountsText } from "./i18n"
import en from "./locales/en"
import { harnessAccounts, harnesses, harnessRunnable, MACHINE_LOGIN_KEY, selectedAccountKey, TEAM_ACCOUNT_KEY, type AccountsSnapshot } from "./model"

const t: AccountsText = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), en[key])
const words = { t, windowName: (window: { readonly window: string }) => window.window }
const claude = harnesses.find((harness) => harness.id === "claude")!

function account(id: string, providerId: string, fields: Partial<Account> = {}): Account {
  return { id, providerId, kind: "api_key", source: "managed", active: false, hasSecret: true, ...fields }
}

function snapshot(fields: { stored?: readonly Account[]; effective?: readonly Account[]; team?: readonly Account[]; sources?: Readonly<Record<string, AccountSource>> } = {}): AccountsSnapshot {
  return {
    stored: fields.stored ?? [],
    effective: fields.effective ? new Map(fields.effective.map((row) => [row.providerId, row])) : undefined,
    machineLogins: [{ harness: "claude", providerIds: claude.providerIds, state: "signed_in" }],
    sources: { sources: new Map(Object.entries(fields.sources ?? {})), team: fields.team ?? [], canRemoveTeamAccounts: false },
    scannedAt: 1,
  }
}

const allTeam = Object.fromEntries(claude.providerIds.map((id) => [id, "team" as const]))

test("accounts: a harness whose every provider spends the team account selects the team entry and runs on the team's row", () => {
  const own = account("own-1", "claude-sdk", { active: true })
  const team = account("team-1", "claude-sdk", { label: "Acme team", health: "ok", lastValidatedAt: 5 })
  const chosen = snapshot({ stored: [own], team: [team], sources: allTeam, effective: [team] })
  expect(selectedAccountKey(claude, chosen)).toBe(TEAM_ACCOUNT_KEY)
  expect(harnessRunnable(claude, chosen, {})).toBe(true)
  expect(teamAccountWords(words, claude, chosen, true, false)).toMatchObject({ key: TEAM_ACCOUNT_KEY, ids: [], label: "Acme team", team: true, disabled: false, refused: false })
  expect(teamAccountWords(words, claude, chosen, true, true)?.ids).toEqual([team.id])
  expect(teamAccountWords(words, claude, chosen, false, false)).toMatchObject({ label: "Acme team", disabled: false })
  expect(harnessRunnable(claude, snapshot({ stored: [own], team: [account("team-1", "claude-sdk", { health: "auth_failed", lastValidatedAt: 5 })], sources: allTeam }), {})).toBe(false)
})

test("accounts: a person who chose the team account where the organization holds none cannot run and is told why", () => {
  const chosen = snapshot({ stored: [account("own-1", "claude-sdk", { active: true })], sources: allTeam })
  expect(selectedAccountKey(claude, chosen)).toBe(TEAM_ACCOUNT_KEY)
  expect(harnessRunnable(claude, chosen, {})).toBe(false)
  const unavailable = t("settings.providers.accountSource.unavailable", { name: "Claude Code" })
  expect(teamAccountWords(words, claude, chosen, true, true)).toMatchObject({ label: "Team account", detail: unavailable, alert: unavailable, disabled: true, ids: [] })
  expect(teamAccountWords(words, claude, snapshot(), false, false)).toBeUndefined()
  expect(teamAccountWords(words, claude, snapshot(), false, true)).toBeUndefined()
})

test("accounts: on the person's own side a team row the effective read names is not theirs, so their own mark or login decides", () => {
  const team = account("team-1", "claude-sdk")
  expect(selectedAccountKey(claude, snapshot({ effective: [team], team: [team] }))).toBe(MACHINE_LOGIN_KEY)
  const own = account("own-1", "claude-sdk", { active: true })
  expect(selectedAccountKey(claude, snapshot({ stored: [own], effective: [team], team: [team], sources: { "claude-sdk": "team" } }))).toBe("own-1")
})

test("accounts: an account's cloud consent is shared when any of its bindings is, partial when only some are, and deliverable only with a scope and a cloud destination", () => {
  const cloud = { local: true, cloud: true }
  const rows = [
    account("a", "claude-sdk", { accountId: "acct", scope: "shared", delivery: cloud }),
    account("b", "claude-acp", { accountId: "acct", scope: "local", delivery: cloud }),
  ]
  const [merged] = harnessAccounts(claude, rows)
  expect(merged).toMatchObject({ ids: ["a", "b"], scope: "shared", partialCloudConsent: true })
  expect(storedAccountWords(words, merged, undefined).cloudConsent).toEqual({ allowed: true, partial: true, deliverable: true })

  const blocked = { local: true, cloud: false, reason: "no_destination" }
  const [local] = harnessAccounts(claude, [account("c", "claude-sdk", { accountId: "other", scope: "local", delivery: cloud }), account("d", "anthropic", { accountId: "other", scope: "local", delivery: blocked })])
  expect(local).toMatchObject({ scope: "local", partialCloudConsent: false, delivery: blocked })
  expect(storedAccountWords(words, local, undefined).cloudConsent).toEqual({ allowed: false, partial: false, deliverable: false })

  const [unscoped] = harnessAccounts(claude, [account("e", "claude-sdk", { delivery: cloud })])
  expect(storedAccountWords(words, unscoped, undefined).cloudConsent).toEqual({ allowed: false, partial: false, deliverable: false })
  const [undelivered] = harnessAccounts(claude, [account("f", "claude-sdk", { scope: "local" })])
  expect(storedAccountWords(words, undelivered, undefined).cloudConsent).toBeUndefined()
})
