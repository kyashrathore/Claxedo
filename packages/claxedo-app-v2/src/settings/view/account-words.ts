import type { DomainTranslate } from "@/i18n"
import type { QuotaWindow } from "@/usage"
import type { Keys } from "../i18n"
import {
  accountIdentity,
  accountLabel,
  accountReach,
  isRefusal,
  isUnavailable,
  MACHINE_LOGIN_KEY,
  partialMachineLogin,
  strandedBinding,
  storedCheck,
  type AccountReach,
  type AccountsSnapshot,
  type Harness,
  type HarnessAccount,
  type LiveCheck,
} from "../accounts"
import type { AccountVerdict, MachineLogin } from "@/server"

export type AccountWords = {
  readonly key: string
  readonly ids: readonly string[]
  readonly label: string
  readonly detail?: string
  readonly note?: string
  readonly alert?: string
  readonly checkedAt?: number
  readonly refused: boolean
  readonly reach?: AccountReach
  readonly machine: boolean
  readonly disabled: boolean
}

type Words = { readonly t: DomainTranslate<Keys>; readonly windowName: (window: QuotaWindow) => string }

const VERDICT_KEY = {
  ok: "settings.accounts.verdict.ok",
  auth_failed: "settings.accounts.verdict.authFailed",
  no_billing: "settings.accounts.verdict.noBilling",
  rate_capped: "settings.accounts.verdict.rateCapped",
  expired: "settings.accounts.verdict.expired",
  unknown: "settings.accounts.verdict.unknown",
} as const satisfies Record<AccountVerdict, Keys>

const MACHINE_REACH: Readonly<Record<string, readonly string[]>> = {
  cursor: ["Works with Cursor ACP", "the Cursor SDK needs an API key"],
}

function windowWords(words: Words, windows: readonly QuotaWindow[] | undefined) {
  return (windows ?? []).map((window) => words.t("settings.accounts.window", { name: words.windowName(window), used: Math.round(window.usedPercent) }))
}

function verdictWords(t: Words["t"], live: LiveCheck | undefined) {
  if (live?.verdict === undefined) return []
  return [t(VERDICT_KEY[live.verdict]), ...(live.reason === undefined ? [] : [live.reason])]
}

export function storedAccountWords(words: Words, row: HarnessAccount, live: LiveCheck | undefined): AccountWords {
  const { t } = words
  const check = storedCheck(row, live)
  const identity = accountIdentity(row)
  const label = accountLabel(row)
  const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
  const details = [...(readable === undefined ? [] : [readable]), ...verdictWords(t, check), ...windowWords(words, check?.usage)]
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
    ...(reach === undefined ? {} : { reach }),
    machine: false,
    disabled: false,
  }
}

function machineDetail(words: Words, login: MachineLogin, harness: Harness) {
  const { t } = words
  if (login.state === "absent") return t("settings.accounts.machineNotInstalled")
  if (login.state === "signed_out") return t("settings.accounts.machineSignedOut", { command: harness.signIn })
  if (login.state === "unknown") return login.detail ?? t("settings.accounts.machineUnknown")
  const windows = windowWords(words, login.usage)
  if (windows.length > 0) return windows.join(" · ")
  const identity = [login.plan ? t("settings.accounts.machinePlan", { plan: login.plan }) : undefined, login.org].filter((word): word is string => word !== undefined)
  return identity.length > 0 ? identity.join(" · ") : undefined
}

export function machineLoginWords(words: Words, login: MachineLogin, harness: Harness, snapshot: AccountsSnapshot): AccountWords {
  const { t } = words
  const detail = machineDetail(words, login, harness)
  const stranded = login.state !== "absent" && strandedBinding(login, harness, snapshot.effective)
  const note = [
    ...(partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []) : []),
    ...(stranded ? [t("settings.accounts.machineStrands", { name: harness.label })] : []),
  ].join(" · ")
  const reach = accountReach(undefined)
  return {
    key: MACHINE_LOGIN_KEY,
    ids: [],
    label: login.state === "signed_in" && login.email ? login.email : t("settings.accounts.machineLogin"),
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
