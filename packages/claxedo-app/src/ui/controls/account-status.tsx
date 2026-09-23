import { For, createSignal, onCleanup, type Component } from "solid-js"
import type { QuotaWindow } from "@claxedo/usage-contract"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { formatCompactAge, formatRelativeTime } from "@/lib/relative-time"
import { readBoolean, readField, readFiniteNumber, readString } from "@/lib/record"

/**
 * What one account is doing, in the words and marks every surface that lists
 * accounts draws it with: the provider's verdict, the windows it reported, how
 * far the account reaches, and when it was last read.
 *
 * The agents list in Settings and the quota cards in Usage draw the same
 * account from the same two routes. Held apart they said different things about
 * one row — the refusal rule was written twice and the window names three
 * times — so a vendor slot named here appeared under its raw id there.
 */

/** What a provider said about one stored account. `unknown` never reached it. */
export type ProviderVerdict = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired" | "unknown"

export const VERDICT_KEY: Record<ProviderVerdict, string> = {
  ok: "settings.providers.live.ok",
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  rate_capped: "settings.providers.live.rateCapped",
  expired: "settings.providers.live.expired",
  unknown: "settings.providers.live.unknown",
}

/** The verdicts only a different credential, or a fresh login, can answer. */
export function isRefusal(verdict: string): verdict is "auth_failed" | "no_billing" | "expired" {
  return verdict === "auth_failed" || verdict === "no_billing" || verdict === "expired"
}

/**
 * The verdicts that leave a working login unusable for now: the provider's own
 * cap, and a check that never reached it. Connecting again answers neither, so
 * a row marks these rather than offering to reconnect.
 */
export function isUnavailable(verdict: string): verdict is "rate_capped" | "unknown" {
  return verdict === "rate_capped" || verdict === "unknown"
}

/** The verdicts a provider itself returns, and which a row can hold stored. */
export function isStoredVerdict(value: string): value is Exclude<ProviderVerdict, "unknown"> {
  return value !== "unknown" && value in VERDICT_KEY
}

/**
 * The plan windows in one usage read, from whichever route carried it. An
 * entry that names no window, or reports no figure, is not a window: the
 * surfaces draw a bar per entry and would draw a nameless empty one.
 */
export function readUsageWindows(value: unknown): QuotaWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows = value.flatMap((entry): QuotaWindow[] => {
    const window = readString(entry, "window")
    const usedPercent = readFiniteNumber(entry, "usedPercent")
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: readFiniteNumber(entry, "resetsAt") ?? null }]
  })
  return windows.length > 0 ? windows : undefined
}

/** The dictionary entry each quota window is named by. */
export const WINDOW_KEY: Record<string, string> = {
  session: "settings.providers.window.session",
  weekly: "settings.providers.window.weekly",
  weekly_opus: "settings.providers.window.weeklyOpus",
}

/** Where a turn on one account can run. */
export type AccountReach = "local-and-cloud" | "local-only"

/** Where the credential authority says this account's secret can be delivered. */
export type AccountDelivery = { local: boolean; cloud: boolean; reason?: string }

/** The authority's answer, off a row of any route that carries one. */
export function readAccountDelivery(row: unknown): AccountDelivery | undefined {
  const field = readField(row, "deliverable")
  const cloud = readBoolean(field, "cloud")
  if (cloud === undefined) return undefined
  const reason = readString(field, "reason")
  return {
    local: readBoolean(field, "local") ?? true,
    cloud,
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * Where a turn on one account can run, as the authority answered, or nothing
 * for an account no workspace of ours runs a turn on at all — an agent
 * installed beside Claxedo, whose plan is worth reading and whose whereabouts
 * are not the reader's to choose.
 *
 * Never inferred from the kind of row: a stored subscription whose destination
 * needs a companion header is refused in a sandbox exactly as this computer's
 * own login is, so "it is stored, therefore it runs in the cloud" advertises
 * reach the account does not have. An answer that has not arrived is local.
 */
export function accountReach(delivery: AccountDelivery | undefined): AccountReach | undefined {
  if (delivery === undefined) return "local-only"
  if (delivery.cloud) return "local-and-cloud"
  return delivery.local ? "local-only" : undefined
}

/**
 * Which places a reach draws, and what the pair of them means, as dictionary
 * keys. A reach is two facts about one account and the icons say them one each,
 * so `local-and-cloud` is `local-only` plus the cloud rather than a third mark
 * a reader has to learn. The names are catalog entries; `as const` keeps them
 * narrow enough for `ClaxedoIcon` to reject a typo.
 */
export const ACCOUNT_REACH_KEYS = {
  "local-and-cloud": {
    places: [
      { icon: "monitor", label: "settings.providers.agents.reachLocal" },
      { icon: "cloud", label: "settings.providers.agents.reachCloud" },
    ],
    note: "settings.providers.agents.reachLocalCloudNote",
  },
  "local-only": {
    places: [{ icon: "monitor", label: "settings.providers.agents.reachLocal" }],
    note: "settings.providers.agents.reachLocalOnlyNote",
  },
} as const satisfies Record<AccountReach, {
  places: ReadonlyArray<{ icon: string; label: string }>
  note: string
}>

/** The surface's own translator: reusable UI may not reach the language provider. */
type Translate = (key: string, vars?: Record<string, string>) => string

/**
 * The marks alone. What explains them is a tooltip, and the two surfaces hang
 * it off different triggers — inside a radio's `<label>` a press would
 * otherwise choose the account — so each supplies its own around these.
 */
export const AccountReachMarks: Component<{
  reach: AccountReach
  /** The surface's own hook for the group of marks. */
  component: string
  t: Translate
  class?: string
  iconClass?: string
}> = (props) => (
  <span class={props.class} data-component={props.component} data-reach={props.reach}>
    <For each={ACCOUNT_REACH_KEYS[props.reach].places}>
      {(place) => (
        <ClaxedoIcon
          name={place.icon}
          size="small"
          class={props.iconClass}
          role="img"
          aria-hidden="false"
          aria-label={props.t(place.label)}
        />
      )}
    </For>
  </span>
)

/** The whole sentence the compact age stands for, for readers who cannot see it. */
export function lastCheckedSentence(t: Translate, at: number, locale?: string, now = Date.now()) {
  return t("common.lastChecked", { ago: formatRelativeTime(at, locale, now) })
}

/** The smallest bucket the compact age moves by. */
const AGE_TICK_MS = 60_000

/**
 * When the figures on one row were read, in the one unit a narrow column has
 * room for. Below the smallest bucket there is no figure worth showing, so the
 * column says the word instead. The row stays open while its figures age, so
 * the age is re-read once per bucket rather than only when the figures change.
 */
export const CheckedAge: Component<{
  at: number
  component: string
  t: Translate
  locale?: string
  class?: string
}> = (props) => {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), AGE_TICK_MS)
  onCleanup(() => clearInterval(timer))
  // The tick only schedules the re-read. The time itself is taken fresh, so
  // figures read since the last tick are not dated ahead of it.
  const now = () => {
    tick()
    return Date.now()
  }
  return (
    <span
      class={props.class}
      data-component={props.component}
      aria-label={lastCheckedSentence(props.t, props.at, props.locale, now())}
    >
      {formatCompactAge(props.at, now()) ?? props.t("common.justNow")}
    </span>
  )
}
