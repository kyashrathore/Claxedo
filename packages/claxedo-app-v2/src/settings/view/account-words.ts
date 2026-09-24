import type { QuotaWindow } from "@claxedo/usage-contract"
import type { DomainTranslate } from "@/i18n"
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
  type MachineLogin,
  type ProviderVerdict,
} from "../accounts"

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

type Translate = DomainTranslate<Keys>

const VERDICT_KEY = {
  ok: "settings.accounts.verdict.ok",
  auth_failed: "settings.accounts.verdict.authFailed",
  no_billing: "settings.accounts.verdict.noBilling",
  rate_capped: "settings.accounts.verdict.rateCapped",
  expired: "settings.accounts.verdict.expired",
  unknown: "settings.accounts.verdict.unknown",
} as const satisfies Record<ProviderVerdict, Keys>

const WINDOW_KEY: Readonly<Record<string, Keys>> = {
  session: "settings.accounts.window.session",
  weekly: "settings.accounts.window.weekly",
  weekly_opus: "settings.accounts.window.weeklyOpus",
}

const MACHINE_REACH: Readonly<Record<string, readonly string[]>> = {
  cursor: ["Works with Cursor ACP", "the Cursor SDK needs an API key"],
}

function windowWords(t: Translate, windows: readonly QuotaWindow[] | undefined) {
  return (windows ?? []).map((window) => {
    const key = WINDOW_KEY[window.window]
    return t("settings.accounts.window", { name: key ? t(key) : window.window, used: Math.round(window.usedPercent) })
  })
}

function verdictWords(t: Translate, live: LiveCheck | undefined) {
  if (live?.verdict === undefined) return []
  return [t(VERDICT_KEY[live.verdict]), ...(live.reason === undefined ? [] : [live.reason])]
}

export function storedAccountWords(t: Translate, row: HarnessAccount, live: LiveCheck | undefined, selected: boolean): AccountWords {
  const check = storedCheck(row, live)
  const identity = accountIdentity(row)
  const label = accountLabel(row)
  const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
  const words = [...(readable === undefined ? [] : [readable]), ...verdictWords(t, check), ...windowWords(t, check?.usage)]
  const refused = check?.verdict !== undefined && isRefusal(check.verdict)
  const alert = check?.verdict !== undefined && isUnavailable(check.verdict) ? verdictWords(t, check).join(" · ") : undefined
  const reach = accountReach(row.delivery)
  return {
    key: row.id,
    ids: row.ids,
    label,
    ...(words.length > 0 ? { detail: words.join(" · ") } : {}),
    ...(alert === undefined ? {} : { alert }),
    ...(check === undefined ? {} : { checkedAt: check.at }),
    refused,
    ...(reach === undefined ? {} : { reach }),
    machine: false,
    disabled: false,
    ...(selected ? {} : {}),
  }
}

function machineDetail(t: Translate, login: MachineLogin, harness: Harness) {
  if (login.state === "absent") return t("settings.accounts.machineNotInstalled")
  if (login.state === "signed_out") return t("settings.accounts.machineSignedOut", { command: harness.signIn })
  if (login.state === "unknown") return login.detail ?? t("settings.accounts.machineUnknown")
  const windows = windowWords(t, login.usage)
  if (windows.length > 0) return windows.join(" · ")
  const identity = [login.plan ? t("settings.accounts.machinePlan", { plan: login.plan }) : undefined, login.org].filter((word): word is string => word !== undefined)
  return identity.length > 0 ? identity.join(" · ") : undefined
}

export function machineLoginWords(t: Translate, login: MachineLogin, harness: Harness, snapshot: AccountsSnapshot): AccountWords {
  const detail = machineDetail(t, login, harness)
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
