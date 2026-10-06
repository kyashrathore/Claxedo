/// <reference types="bun" />
import type { AccountSource } from "@claxedo/account-contract/vocabulary"
import { expect, test } from "bun:test"
import type { Account } from "@/server"
import { orgAccountWords, storedAccountWords } from "./account-words"
import type { AccountsText } from "./i18n"
import en from "./locales/en"
import { harnessAccounts, harnesses, harnessRunnable, MACHINE_LOGIN_KEY, ORG_ACCOUNT_KEY, selectedAccountKey, type AccountsSnapshot } from "./model"

const t: AccountsText = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), en[key])
const words = { t, windowName: (window: { readonly window: string }) => window.window }
const claude = harnesses.find((harness) => harness.id === "claude")!

function account(id: string, providerId: string, fields: Partial<Account> = {}): Account {
  return { id, providerId, kind: "api_key", source: "managed", active: false, hasSecret: true, ...fields }
}

function snapshot(fields: { cloudOnly?: boolean; stored?: readonly Account[]; effective?: readonly Account[]; org?: readonly Account[]; sources?: Readonly<Record<string, AccountSource>> } = {}): AccountsSnapshot {
  return {
    cloudOnly: fields.cloudOnly ?? false,
    stored: fields.stored ?? [],
    effective: fields.effective ? new Map(fields.effective.map((row) => [row.providerId, row])) : undefined,
    machineLogins: fields.cloudOnly ? [] : [{ harness: "claude", providerIds: claude.providerIds, state: "signed_in" }],
    sources: { sources: new Map(Object.entries(fields.sources ?? {})), org: fields.org ?? [], canRemoveOrgAccounts: false },
    scannedAt: 1,
  }
}

const allOrg = Object.fromEntries(claude.providerIds.map((id) => [id, "org" as const]))

test("accounts: a harness whose every provider spends the org account selects the org entry and runs on the org's row", () => {
  const own = account("own-1", "claude-sdk", { active: true })
  const org = account("org-1", "claude-sdk", { label: "Acme", health: "ok", lastValidatedAt: 5 })
  const chosen = snapshot({ stored: [own], org: [org], sources: allOrg, effective: [org] })
  expect(selectedAccountKey(claude, chosen)).toBe(ORG_ACCOUNT_KEY)
  expect(harnessRunnable(claude, chosen, {})).toBe(true)
  expect(orgAccountWords(words, claude, chosen, true, false)).toMatchObject({ key: ORG_ACCOUNT_KEY, ids: [], label: "Acme", disabled: false, refused: false })
  expect(orgAccountWords(words, claude, chosen, true, true)?.ids).toEqual([org.id])
  expect(orgAccountWords(words, claude, chosen, false, false)).toMatchObject({ label: "Acme", disabled: false })
  expect(harnessRunnable(claude, snapshot({ stored: [own], org: [account("org-1", "claude-sdk", { health: "auth_failed", lastValidatedAt: 5 })], sources: allOrg }), {})).toBe(false)
})

test("accounts: a person who chose the org account where the organization holds none cannot run and is told why", () => {
  const chosen = snapshot({ stored: [account("own-1", "claude-sdk", { active: true })], sources: allOrg })
  expect(selectedAccountKey(claude, chosen)).toBe(ORG_ACCOUNT_KEY)
  expect(harnessRunnable(claude, chosen, {})).toBe(false)
  const unavailable = t("settings.providers.accountSource.unavailable", { name: "Claude Code" })
  expect(orgAccountWords(words, claude, chosen, true, true)).toMatchObject({ label: "Organization account", detail: unavailable, alert: unavailable, disabled: true, ids: [] })
  expect(orgAccountWords(words, claude, snapshot(), false, false)).toBeUndefined()
  expect(orgAccountWords(words, claude, snapshot(), false, true)).toBeUndefined()
})

test("accounts: on the person's own side an org row the effective read names is not theirs, so their own mark or login decides", () => {
  const org = account("org-1", "claude-sdk")
  expect(selectedAccountKey(claude, snapshot({ effective: [org], org: [org] }))).toBe(MACHINE_LOGIN_KEY)
  const own = account("own-1", "claude-sdk", { active: true })
  expect(selectedAccountKey(claude, snapshot({ stored: [own], effective: [org], org: [org], sources: { "claude-sdk": "org" } }))).toBe("own-1")
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

test("accounts: where every session runs in the cloud, an account counts only if the server can deliver it there", () => {
  const codex = harnesses.find((harness) => harness.id === "codex")!
  const chatgpt = account("chatgpt", "codex-app-server", { kind: "oauth_token", active: true, delivery: { local: true, cloud: false, reason: "native_delivery_needs_companion_header" } })
  const key = account("key", "codex-app-server", { active: true, delivery: { local: true, cloud: true } })
  expect(harnessRunnable(codex, snapshot({ cloudOnly: true, stored: [chatgpt], effective: [chatgpt] }), {})).toBe(false)
  expect(harnessRunnable(codex, snapshot({ cloudOnly: false, stored: [chatgpt], effective: [chatgpt] }), {})).toBe(true)
  expect(harnessRunnable(codex, snapshot({ cloudOnly: true, stored: [key], effective: [key] }), {})).toBe(true)
})

test("accounts: in the cloud the most recently chosen of a harness's accounts is the one in use; a machine binds its first provider", () => {
  const token = account("token", "claude-sdk", { kind: "oauth_token", active: true, activatedAt: 1, delivery: { local: true, cloud: true } })
  const key = account("key", "anthropic", { active: true, activatedAt: 2, delivery: { local: true, cloud: true } })
  expect(selectedAccountKey(claude, snapshot({ cloudOnly: true, stored: [token, key], effective: [token, key] }))).toBe("key")
  expect(selectedAccountKey(claude, snapshot({ cloudOnly: true, stored: [token, key], effective: [{ ...token, activatedAt: 3 }, key] }))).toBe("token")
  expect(selectedAccountKey(claude, snapshot({ stored: [token, key], effective: [token, key] }))).toBe("token")
})

test("accounts: in the cloud an account no sandbox can be delivered is never the one in use, however recently chosen", () => {
  const codex = harnesses.find((harness) => harness.id === "codex")!
  const key = account("key", "openai", { active: true, activatedAt: 1, delivery: { local: true, cloud: true } })
  const chatgpt = account("chatgpt", "codex-app-server", { kind: "oauth_token", active: true, activatedAt: 2, delivery: { local: true, cloud: false } })
  expect(selectedAccountKey(codex, snapshot({ cloudOnly: true, stored: [key, chatgpt], effective: [key, chatgpt] }))).toBe("key")
})

test("accounts: an account the org's cloud provider cannot hand a harness says where it still works, through Pi when Pi spends it", () => {
  const brokered = { local: true, cloud: true, cloudHarness: true }
  const refused = { local: true, cloud: true, cloudHarness: false }
  const [claudeKey] = harnessAccounts(claude, [account("a", "claude-sdk", { delivery: refused })])
  expect(storedAccountWords(words, claudeKey, undefined).cloudNote).toBe("Works on your machines and through Pi in cloud workspaces")
  const cursorHarness = harnesses.find((harness) => harness.id === "cursor")!
  const [cursorKey] = harnessAccounts(cursorHarness, [account("b", "cursor-sdk", { delivery: refused })])
  expect(storedAccountWords(words, cursorKey, undefined).cloudNote).toBe("Works on your machines; your organization's cloud provider can't run it")
  const [usable] = harnessAccounts(claude, [account("c", "claude-sdk", { delivery: brokered })])
  expect(storedAccountWords(words, usable, undefined).cloudNote).toBeUndefined()
})
