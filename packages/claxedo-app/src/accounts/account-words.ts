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
  storedCheck,
  type AccountReach,
  type AccountsSnapshot,
  type Harness,
  type HarnessAccount,
  type LiveCheck,
} from "./model"
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
  readonly identity?: string
  readonly reach?: AccountReach
  readonly machine: boolean
  readonly disabled: boolean
}

type Words = { readonly t: AccountsText; readonly windowName: (window: QuotaWindow) => string }

const VERDICT_KEY = {
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
    ...(identity === undefined || identity.readable ? {} : { identity: identity.text }),
    ...(reach === undefined ? {} : { reach }),
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
  const stranded = login.state !== "absent" && strandedBinding(login, harness, snapshot.effective)
  const note = [
    ...(partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []).map((key) => t(key)) : []),
    ...(stranded ? [t("settings.providers.agents.machineStrands", { name: harness.label })] : []),
  ].join(" · ")
  const reach = accountReach(undefined)
  return {
    key: MACHINE_LOGIN_KEY,
    ids: [],
    label: login.state === "signed_in" && login.email ? login.email : t("settings.providers.agents.machineLogin"),
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
