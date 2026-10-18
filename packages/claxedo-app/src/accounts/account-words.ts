import { piProviderSpending, type HarnessId } from "@claxedo/agent-runtime-contract"
import { formatRelativeTime } from "@/lib/relative-time"
import type { QuotaWindow } from "@/usage"
import type { AccountsKey, AccountsText } from "./i18n"
import {
  accountIdentity,
  accountLabel,
  accountReach,
  harnessesServedBy,
  servedByList,
  isRefusal,
  isUnavailable,
  isVerdict,
  MACHINE_LOGIN_KEY,
  ORG_ACCOUNT_KEY,
  orgAccountOf,
  partialMachineLogin,
  storedCheck,
  strandedBinding,
  type AccountReach,
  type AccountsSnapshot,
  type Harness,
  type HarnessAccount,
  type LiveCheck,
} from "./model"
import type { Account, AccountVerdict, MachineLogin } from "@/server"

export type CloudConsent = {
  readonly allowed: boolean
  readonly partial: boolean
  readonly deliverable: boolean
}

export const ACCOUNT_GROUPS = ["stored", "machine", "org"] as const

export type AccountGroup = (typeof ACCOUNT_GROUPS)[number]

export type AccountWords = {
  readonly key: string
  readonly ids: readonly string[]
  readonly group: AccountGroup
  readonly label: string
  readonly kind: string
  readonly detail?: string
  readonly note?: string
  readonly where?: string
  readonly alert?: string
  readonly checkedAt?: number
  readonly refused: boolean
  readonly identity?: string
  readonly cloudConsent?: CloudConsent
  readonly disabled: boolean
}

export type AccountGroupRows = { readonly group: AccountGroup; readonly rows: readonly AccountWords[] }

export type CloudChoiceWords = { readonly trigger: string; readonly title: string; readonly lines: readonly string[] }

type Words = { readonly t: AccountsText; readonly windowName: (window: QuotaWindow) => string; readonly machineName?: string; readonly onMachine?: boolean; readonly locale?: string; readonly now?: number }

export const VERDICT_KEY = {
  ok: "settings.providers.live.ok",
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  rate_capped: "settings.providers.live.rateCapped",
  expired: "settings.providers.live.expired",
  unknown: "settings.providers.live.unknown",
} as const satisfies Record<AccountVerdict, AccountsKey>

const REACH_KEY = {
  "local-and-cloud": "settings.providers.agents.reach.localAndCloud",
  "local-only": "settings.providers.agents.reach.localOnly",
} as const satisfies Record<AccountReach, AccountsKey>

const MACHINE_REACH: Readonly<Record<string, readonly AccountsKey[]>> = {
  cursor: ["settings.providers.agents.machineCursorAcp", "settings.providers.agents.machineCursorSdkKey"],
}

const PLAN_KIND: Readonly<Record<HarnessId, AccountsKey>> = {
  claude: "settings.providers.agents.kind.claudePlan",
  codex: "settings.providers.agents.kind.chatgptPlan",
  cursor: "settings.providers.agents.kind.cursorPlan",
}

const PLAN_CREDENTIAL_KINDS: ReadonlySet<string> = new Set(["oauth_token", "subscription_session"])

function windowWords(words: Words, windows: readonly QuotaWindow[] | undefined) {
  return (windows ?? []).map((window) => words.t("settings.providers.live.window", { name: words.windowName(window), used: Math.round(window.usedPercent) }))
}

function rateCapReset(words: Words, live: LiveCheck) {
  if (live.verdict !== "rate_capped") return []
  const resets = (live.usage ?? []).flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt]))
  if (resets.length === 0) return []
  return [words.t("settings.providers.live.resets", { when: formatRelativeTime(Math.min(...resets), words.locale, words.now) })]
}

function verdictWords(words: Words, live: LiveCheck | undefined) {
  if (live?.verdict === undefined) return []
  return [words.t(VERDICT_KEY[live.verdict]), ...rateCapReset(words, live), ...(live.reason === undefined ? [] : [live.reason])]
}

export function keyCheckWords(t: AccountsText, account: Pick<Account, "health">, live: LiveCheck | undefined): readonly string[] {
  if (live?.uncheckable) return [t("settings.providers.live.uncheckable")]
  const stored = account.health !== undefined && isVerdict(account.health) ? account.health : undefined
  const verdict = live?.verdict ?? stored
  if (verdict === undefined) return [t("settings.keys.notChecked")]
  return [t(VERDICT_KEY[verdict]), ...(live?.reason === undefined ? [] : [live.reason])]
}

function kindWord(t: AccountsText, harness: Harness, credentialKind: string) {
  return t(PLAN_CREDENTIAL_KINDS.has(credentialKind) ? PLAN_KIND[harness.id] : "settings.providers.agents.kind.apiKey")
}

function whereWords(words: Words, row: HarnessAccount | undefined, reach: AccountReach | undefined) {
  if (row?.delivery?.cloudHarness === false) return { where: words.t(piProviderSpending(row.providerId) ? "settings.providers.agents.cloudThroughPi" : "settings.providers.agents.cloudMachinesOnly") }
  return words.onMachine && reach !== undefined ? { where: words.t(REACH_KEY[reach]) } : {}
}

function cloudConsentOf(row: HarnessAccount): CloudConsent | undefined {
  if (row.delivery === undefined) return undefined
  return { allowed: row.scope === "shared", partial: row.partialCloudConsent, deliverable: row.delivery.cloud && row.scope !== undefined }
}

function storedReach(row: HarnessAccount, consent: CloudConsent | undefined): AccountReach | undefined {
  if (consent?.deliverable) return consent.allowed ? "local-and-cloud" : "local-only"
  return accountReach(row.delivery)
}

export function storedAccountWords(words: Words, harness: Harness, row: HarnessAccount, live: LiveCheck | undefined): AccountWords {
  const { t } = words
  const check = storedCheck(row, live)
  const identity = accountIdentity(row)
  const label = accountLabel(row)
  const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
  const details = [...(readable === undefined ? [] : [readable]), ...verdictWords(words, check), ...windowWords(words, check?.usage)]
  const cloudConsent = cloudConsentOf(row)
  const alert = check?.verdict !== undefined && isUnavailable(check.verdict) ? verdictWords(words, check).join(" · ") : undefined
  return {
    key: row.id,
    ids: row.ids,
    group: "stored",
    label,
    kind: kindWord(t, harness, row.kind),
    ...(details.length > 0 ? { detail: details.join(" · ") } : {}),
    ...(alert === undefined ? {} : { alert }),
    ...(check === undefined ? {} : { checkedAt: check.at }),
    refused: check?.verdict !== undefined && isRefusal(check.verdict),
    ...(identity === undefined || identity.readable ? {} : { identity: identity.text }),
    ...whereWords(words, row, storedReach(row, cloudConsent)),
    ...(cloudConsent === undefined ? {} : { cloudConsent }),
    disabled: false,
  }
}

export function orgAccountWords(words: Words, harness: Harness, snapshot: AccountsSnapshot, chosen: boolean, manages: boolean, live: Readonly<Record<string, LiveCheck>>): AccountWords | undefined {
  const { t } = words
  const row = orgAccountOf(harness, snapshot)
  const kind = t("settings.providers.agents.kind.apiKey")
  if (row === undefined) {
    if (!chosen) return undefined
    const unavailable = t("settings.providers.accountSource.unavailable", { name: harness.vendor })
    return { key: ORG_ACCOUNT_KEY, ids: [], group: "org", label: t("settings.providers.accountSource.org"), kind, detail: unavailable, alert: unavailable, refused: false, disabled: true }
  }
  const check = storedCheck(row, live[row.id])
  const alert = check?.verdict !== undefined && isUnavailable(check.verdict) ? verdictWords(words, check).join(" · ") : undefined
  return {
    key: ORG_ACCOUNT_KEY,
    ids: manages ? row.ids : [],
    group: "org",
    label: accountLabel(row),
    kind,
    detail: [t("settings.providers.accountSource.org"), ...verdictWords(words, check), ...windowWords(words, check?.usage)].join(" · "),
    ...(alert === undefined ? {} : { alert }),
    ...(check === undefined ? {} : { checkedAt: check.at }),
    refused: check?.verdict !== undefined && isRefusal(check.verdict),
    ...whereWords(words, row, accountReach(row.delivery)),
    disabled: false,
  }
}

export function groupAccounts(rows: readonly AccountWords[]): readonly AccountGroupRows[] {
  return ACCOUNT_GROUPS.flatMap((group) => {
    const members = rows.filter((row) => row.group === group)
    return members.length > 0 ? [{ group, rows: members }] : []
  })
}

function signedInDetail(words: Words, login: MachineLogin) {
  const { t } = words
  const who = login.email ? t("settings.providers.agents.machineSignedInAs", { email: login.email }) : t("settings.providers.agents.machineSignedIn")
  const windows = windowWords(words, login.usage)
  const plan = login.plan ? [t("settings.providers.agents.machinePlan", { plan: login.plan })] : []
  const identity = windows.length > 0 ? windows : [...plan, ...(login.org ? [login.org] : [])]
  return [who, ...identity].join(" · ")
}

function machineDetail(words: Words, login: MachineLogin, harness: Harness) {
  const { t } = words
  if (login.state === "absent") return t("settings.providers.agents.machineNotInstalled")
  if (login.state === "signed_out") return t("settings.providers.agents.machineSignedOut", { command: harness.signIn })
  if (login.state === "unknown") return login.detail ?? t("settings.providers.agents.machineUnknown")
  return signedInDetail(words, login)
}

export function machineLoginWords(words: Words, login: MachineLogin, harness: Harness, snapshot: AccountsSnapshot): AccountWords {
  const { t } = words
  const detail = machineDetail(words, login, harness)
  const stranded = login.state !== "absent" && strandedBinding(login, harness, snapshot)
  const note = [
    ...(partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []).map((key) => t(key)) : []),
    ...(stranded ? [t("settings.providers.agents.machineStrands", { name: harness.label })] : []),
  ].join(" · ")
  return {
    key: MACHINE_LOGIN_KEY,
    ids: [],
    group: "machine",
    label: t("settings.providers.agents.machineLoginTitle", { harness: harness.label, machine: words.machineName ?? t("settings.providers.agents.machineFallback") }),
    kind: t("settings.providers.agents.kind.cliLogin"),
    detail,
    ...(login.state === "unknown" ? { alert: detail } : {}),
    ...(login.usageAt === undefined ? {} : { checkedAt: login.usageAt }),
    ...(note === "" ? {} : { note }),
    refused: false,
    ...whereWords(words, undefined, accountReach(undefined)),
    disabled: login.state === "absent" || stranded,
  }
}

export function offersCloudChoice(cloudOnly: boolean, rows: readonly AccountWords[]): boolean {
  return cloudOnly && rows.filter((row) => !row.disabled).length >= 2
}

export function cloudChoiceWords(t: AccountsText, harness: Harness, locale: string): CloudChoiceWords {
  const vendor = harness.vendor
  const harnesses = servedByList(harness.providerIds, locale)
  return {
    trigger: t("settings.providers.agents.cloudChoice.trigger", { vendor }),
    title: t("settings.providers.agents.cloudChoice.title", { vendor }),
    lines: [
      t("settings.providers.agents.cloudChoice.latest", { vendor }),
      t(harnessesServedBy(harness.providerIds).length > 1 ? "settings.providers.agents.cloudChoice.sharedBy" : "settings.providers.agents.cloudChoice.usedBy", { harnesses }),
      t("settings.providers.agents.cloudChoice.adding"),
    ],
  }
}
