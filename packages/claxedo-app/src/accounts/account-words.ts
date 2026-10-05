import { piProviderSpending } from "@claxedo/agent-runtime-contract"
import type { QuotaWindow } from "@/usage"
import type { AccountsKey, AccountsText } from "./i18n"
import {
  accountIdentity,
  accountLabel,
  accountReach,
  isRefusal,
  isUnavailable,
  MACHINE_LOGIN_KEY,
  partialMachineLogin,
  strandedBinding,
  ORG_ACCOUNT_KEY,
  orgAccountOf,
  storedCheck,
  type AccountReach,
  type AccountsSnapshot,
  type Harness,
  type HarnessAccount,
  type LiveCheck,
} from "./model"
import type { AccountVerdict, MachineLogin } from "@/server"

export type CloudConsent = {
  readonly allowed: boolean
  readonly partial: boolean
  readonly deliverable: boolean
}

export type AccountWords = {
  readonly key: string
  readonly ids: readonly string[]
  readonly label: string
  readonly detail?: string
  readonly note?: string
  readonly cloudNote?: string
  readonly alert?: string
  readonly checkedAt?: number
  readonly refused: boolean
  readonly identity?: string
  readonly reach?: AccountReach
  readonly source?: "machine" | "stored"
  readonly cloudConsent?: CloudConsent
  readonly machine: boolean
  readonly disabled: boolean
}

type Words = { readonly t: AccountsText; readonly windowName: (window: QuotaWindow) => string; readonly machineName?: string }

export const VERDICT_KEY = {
  ok: "settings.providers.live.ok",
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  rate_capped: "settings.providers.live.rateCapped",
  expired: "settings.providers.live.expired",
  unknown: "settings.providers.live.unknown",
} as const satisfies Record<AccountVerdict, AccountsKey>

const MACHINE_REACH: Readonly<Record<string, readonly AccountsKey[]>> = {
  cursor: ["settings.providers.agents.machineCursorAcp", "settings.providers.agents.machineCursorSdkKey"],
}

function windowWords(words: Words, windows: readonly QuotaWindow[] | undefined) {
  return (windows ?? []).map((window) => words.t("settings.providers.live.window", { name: words.windowName(window), used: Math.round(window.usedPercent) }))
}

function verdictWords(t: Words["t"], live: LiveCheck | undefined) {
  if (live?.verdict === undefined) return []
  return [t(VERDICT_KEY[live.verdict]), ...(live.reason === undefined ? [] : [live.reason])]
}

function cloudNoteOf(t: Words["t"], row: HarnessAccount) {
  if (row.delivery?.cloudHarness !== false) return {}
  return { cloudNote: t(piProviderSpending(row.providerId) ? "settings.providers.agents.cloudThroughPi" : "settings.providers.agents.cloudMachinesOnly") }
}

function cloudConsentOf(row: HarnessAccount): CloudConsent | undefined {
  if (row.delivery === undefined) return undefined
  return { allowed: row.scope === "shared", partial: row.partialCloudConsent, deliverable: row.delivery.cloud && row.scope !== undefined }
}

export function storedAccountWords(words: Words, row: HarnessAccount, live: LiveCheck | undefined): AccountWords {
  const { t } = words
  const check = storedCheck(row, live)
  const identity = accountIdentity(row)
  const label = accountLabel(row)
  const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
  const details = [...(readable === undefined ? [] : [readable]), ...verdictWords(t, check), ...windowWords(words, check?.usage)]
  const cloudConsent = cloudConsentOf(row)
  const refused = check?.verdict !== undefined && isRefusal(check.verdict)
  const alert = check?.verdict !== undefined && isUnavailable(check.verdict) ? verdictWords(t, check).join(" · ") : undefined
  const reach = accountReach(row.delivery)
  return {
    key: row.id,
    ids: row.ids,
    label,
    ...(details.length > 0 ? { detail: details.join(" · ") } : {}),
    ...(alert === undefined ? {} : { alert }),
    ...(check === undefined ? {} : { checkedAt: check.at }),
    refused,
    ...(identity === undefined || identity.readable ? {} : { identity: identity.text }),
    ...(reach === undefined ? {} : { reach }),
    ...cloudNoteOf(t, row),
    source: "stored",
    ...(cloudConsent === undefined ? {} : { cloudConsent }),
    machine: false,
    disabled: false,
  }
}

export function orgAccountWords(words: Words, harness: Harness, snapshot: AccountsSnapshot, chosen: boolean, removable: boolean): AccountWords | undefined {
  const { t } = words
  const row = orgAccountOf(harness, snapshot)
  if (row === undefined) {
    if (!chosen) return undefined
    const unavailable = t("settings.providers.accountSource.unavailable", { name: harness.label })
    return {
      key: ORG_ACCOUNT_KEY,
      ids: [],
      label: t("settings.providers.accountSource.org"),
      detail: unavailable,
      alert: unavailable,
      refused: false,
      machine: false,
      disabled: true,
    }
  }
  const check = storedCheck(row, undefined)
  const alert = check?.verdict !== undefined && isUnavailable(check.verdict) ? verdictWords(t, check).join(" · ") : undefined
  const reach = accountReach(row.delivery)
  return {
    key: ORG_ACCOUNT_KEY,
    ids: removable ? row.ids : [],
    label: accountLabel(row),
    detail: [t("settings.providers.accountSource.org"), ...verdictWords(t, check), ...windowWords(words, check?.usage)].join(" · "),
    ...(alert === undefined ? {} : { alert }),
    ...(check === undefined ? {} : { checkedAt: check.at }),
    refused: check?.verdict !== undefined && isRefusal(check.verdict),
    ...(reach === undefined ? {} : { reach }),
    ...cloudNoteOf(t, row),
    machine: false,
    disabled: false,
  }
}

function machineDetail(words: Words, login: MachineLogin, harness: Harness) {
  const { t } = words
  if (login.state === "absent") return t("settings.providers.agents.machineNotInstalled")
  if (login.state === "signed_out") return t("settings.providers.agents.machineSignedOut", { command: harness.signIn })
  if (login.state === "unknown") return login.detail ?? t("settings.providers.agents.machineUnknown")
  const windows = windowWords(words, login.usage)
  if (windows.length > 0) return windows.join(" · ")
  const identity = [login.plan ? t("settings.providers.agents.machinePlan", { plan: login.plan }) : undefined, login.org].filter((word): word is string => word !== undefined)
  return identity.length > 0 ? identity.join(" · ") : undefined
}

export function machineLoginWords(words: Words, login: MachineLogin, harness: Harness, snapshot: AccountsSnapshot): AccountWords {
  const { t } = words
  const detail = machineDetail(words, login, harness)
  const stranded = login.state !== "absent" && strandedBinding(login, harness, snapshot)
  const note = [
    ...(partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []).map((key) => t(key)) : []),
    ...(stranded ? [t("settings.providers.agents.machineStrands", { name: harness.label })] : []),
  ].join(" · ")
  const reach = accountReach(undefined)
  const email = login.state === "signed_in" ? login.email : undefined
  return {
    key: MACHINE_LOGIN_KEY,
    ids: [],
    label: email ?? t("settings.providers.agents.machineLogin", { machine: words.machineName ?? t("settings.providers.agents.machineFallback") }),
    ...(email ? { source: "machine" as const } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(login.state === "unknown" && detail !== undefined ? { alert: detail } : {}),
    ...(login.usageAt === undefined ? {} : { checkedAt: login.usageAt }),
    ...(note === "" ? {} : { note }),
    refused: false,
    ...(reach === undefined ? {} : { reach }),
    machine: true,
    disabled: login.state === "absent" || stranded,
  }
}
