import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createMemo } from "solid-js"
import type { QuotaAccount, QuotaSnapshot } from "@claxedo/usage-contract"
import { accountReach, ACCOUNT_REACH_KEYS, harnessIcon, harnessLabel } from "@/platform/identity/harness-catalog"
import { useLanguage } from "@/platform/i18n/provider"
import { formatRelativeTime } from "@/lib/relative-time"
import { percentText, readPercent } from "@/lib/percent"

/**
 * A word the card shows. `key` is a dictionary entry; `text` is a string only
 * the snapshot can spell, which no dictionary could hold. Keeping the two apart
 * is what lets `accountCards` and `quotaSummary` be read without a translator.
 */
type Words = { key: string } | { text: string }

type Bar = { name: Words; percent: number; resetsAt: number | null }
type Card = {
  key: string
  harness: string
  label: string
  plan?: string
  inUse: boolean
  /** Set where the account is this computer's own login rather than a stored row. */
  machineLogin: boolean
  /** An agent Claxedo cannot send a turn to; where it runs is not the reader's to choose. */
  otherAgent: boolean
  refusedKey?: string
  usageError?: string
  windows: Bar[]
  usageAt?: number
}
type Group = { key: string; name: Words; icon?: string; cards: Card[] }

const WINDOW_KEY: Record<string, string> = {
  session: "settings.providers.window.session",
  weekly: "settings.providers.window.weekly",
  weekly_opus: "settings.providers.window.weeklyOpus",
}

/** The verdicts only a different account, or a fresh login, can answer. */
const REFUSAL_KEY: Record<string, string> = {
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  expired: "settings.providers.live.expired",
}

/** The group every account no harness can run a turn on collects under. */
const OTHER_AGENTS = "other-agents"

function windowName(name: string): Words {
  const key = WINDOW_KEY[name]
  // A slot the vendor added since this dictionary was written still carries a
  // real figure, so it is drawn under the vendor's own name rather than dropped.
  return key === undefined ? { text: name.replaceAll("_", " ") } : { key }
}

function formatReset(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined
  const minutes = Math.max(0, Math.round((value - Date.now()) / 60_000))
  if (minutes === 0) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function card(account: QuotaAccount, index: number): Card {
  const refusedKey = account.health === undefined ? undefined : REFUSAL_KEY[account.health]
  return {
    key: account.credentialId ?? `${account.harness}-${index}`,
    harness: account.harness,
    // A harness login its CLI reports without an address is the only account
    // that names nothing, and it is always this computer's own.
    label: account.label ?? "This computer's login",
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    inUse: account.inUse,
    machineLogin: account.machineLogin === true,
    otherAgent: account.otherAgent === true,
    ...(refusedKey === undefined ? {} : { refusedKey }),
    ...(account.usageError === undefined ? {} : { usageError: account.usageError }),
    // A refusal outranks whatever the plan last read: the account cannot spend
    // it until it is reconnected, so the bars would be answering another
    // question than the card is.
    windows: refusedKey
      ? []
      : account.windows.map((window) => ({
        name: windowName(window.window),
        percent: Math.max(0, Math.min(100, window.usedPercent)),
        resetsAt: window.resetsAt,
      })),
    ...(account.usageAt === undefined ? {} : { usageAt: account.usageAt }),
  }
}

/**
 * One card per account, under the harness that runs it, in the snapshot's
 * order. Agents Claxedo cannot run a turn on share one trailing group, which
 * lands last because the snapshot orders those accounts last — nothing here
 * sorts.
 */
export function accountCards(snapshot: QuotaSnapshot | undefined): Group[] {
  const groups: Group[] = []
  for (const [index, account] of (snapshot?.accounts ?? []).entries()) {
    const entry = card(account, index)
    const key = account.otherAgent ? OTHER_AGENTS : entry.harness
    const held = groups.find((group) => group.key === key)
    if (held) {
      held.cards.push(entry)
      continue
    }
    groups.push(account.otherAgent
      ? { key, name: { key: "usage.quota.otherAgents" }, cards: [entry] }
      : {
        key,
        name: { text: harnessLabel(entry.harness) ?? entry.harness },
        icon: harnessIcon(entry.harness),
        cards: [entry],
      })
  }
  return groups
}

/**
 * The line above the cards: the tightest window across the accounts in use.
 *
 * `account` names the card that window came off, and is set only where a second
 * card also carries windows — with two populated cards on screen, a bare
 * percentage does not say which one it is about.
 */
export function quotaSummary(snapshot: QuotaSnapshot | undefined) {
  const cards = accountCards(snapshot).flatMap((group) => group.cards)
  const populated = cards.filter((entry) => entry.windows.length > 0)
  const inUse = cards.filter((entry) => entry.inUse)
  const windows = inUse.flatMap((entry) => entry.windows.map((window) => ({ window, owner: entry.label })))
  const constrained = windows.toSorted((a, b) => b.window.percent - a.window.percent)[0]
  const nearestReset = windows
    .map((entry) => entry.window.resetsAt)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .toSorted((a, b) => a - b)[0]
  return {
    accountCount: inUse.length,
    constrainedWindow: constrained?.window.name,
    remainingPercent: constrained ? 100 - constrained.window.percent : undefined,
    nearestReset,
    account: populated.length > 1 ? constrained?.owner : undefined,
  }
}

/** What a card says in place of bars, and whether the reader can ask for them. */
type Note = { text: string; check?: true }

export function QuotaLimitsView(props: {
  snapshot?: QuotaSnapshot
  error?: string
  onCheck?: () => void
  busy?: boolean
}) {
  const language = useLanguage()
  const say = (words: Words) => ("key" in words ? language.t(words.key) : words.text)
  const groups = createMemo(() => accountCards(props.snapshot))
  const summaryWords = createMemo(() => {
    const { constrainedWindow, remainingPercent, nearestReset, account } = quotaSummary(props.snapshot)
    if (constrainedWindow === undefined || remainingPercent === undefined) return undefined
    const summary = account === undefined
      ? language.t("usage.quota.summary", { percent: readPercent(remainingPercent), window: say(constrainedWindow) })
      : language.t("usage.quota.summaryForAccount", {
        percent: readPercent(remainingPercent),
        window: say(constrainedWindow),
        account,
      })
    const reset = formatReset(nearestReset)
    return reset === undefined ? summary : language.t("usage.quota.summaryReset", { summary, reset })
  })
  /** Whether a workspace in a cloud sandbox can run on this account at all. */
  const Reach = (self: { machineLogin: boolean }) => {
    const reach = () => accountReach(self.machineLogin)
    return (
      <Tooltip value={language.t(ACCOUNT_REACH_KEYS[reach()].note)} placement="top">
        <span class="usage-quota-reach" data-component="usage-quota-reach" data-reach={reach()}>
          {language.t(ACCOUNT_REACH_KEYS[reach()].label)}
        </span>
      </Tooltip>
    )
  }
  const note = (entry: Card): Note | undefined => {
    if (entry.refusedKey !== undefined) {
      return { text: `${language.t(entry.refusedKey)} · ${language.t("usage.quota.reconnect")}` }
    }
    if (entry.windows.length > 0) return undefined
    if (entry.usageError !== undefined) return { text: entry.usageError }
    return { text: language.t("usage.quota.notChecked"), check: true }
  }
  return (
    <section class="usage-quota" aria-labelledby="usage-quota-title">
      <div class="usage-section-heading">
        <div><span class="usage-kicker">From your connected accounts</span><h3 id="usage-quota-title">Quota windows</h3></div>
      </div>
      <Show when={summaryWords()}>
        {(words) => <p class="usage-quota-summary">{words()}</p>}
      </Show>
      <Show
        when={groups().length}
        fallback={<div class="usage-chart-empty">{props.error ?? "No connected account reports a plan here."}</div>}
      >
        <For each={groups()}>{(group) => (
          <section class="usage-quota-harness" aria-label={say(group.name)}>
            <h4>
              <Show when={group.icon}>
                {(icon) => <ProviderIcon id={icon()} class="size-4 shrink-0 icon-strong-base" />}
              </Show>
              {say(group.name)}
            </h4>
            <div class="usage-quota-grid">
              <For each={group.cards}>{(entry) => (
                <article
                  class="usage-quota-account"
                  data-account={entry.key}
                  data-refused={entry.refusedKey === undefined ? undefined : "true"}
                >
                  <header>
                    <strong>{entry.label}</strong>
                    <Show when={entry.plan}><span>{entry.plan}</span></Show>
                    <Show when={entry.inUse}><span class="usage-quota-in-use">In use</span></Show>
                    {/*
                      An agent Claxedo cannot send a turn to is on this machine
                      and nowhere else by definition, so where it runs is news
                      about nothing the reader can act on.
                    */}
                    <Show when={!entry.otherAgent}>
                      <Reach machineLogin={entry.machineLogin} />
                    </Show>
                    <Show when={entry.usageAt}>
                      {(at) => (
                        <span class="usage-quota-as-of" data-component="usage-quota-as-of">
                          as of {formatRelativeTime(at())}
                        </span>
                      )}
                    </Show>
                  </header>
                  <Show when={note(entry)}>
                    {(value) => (
                      <p class="usage-quota-account-note">
                        {value().text}
                        <Show when={value().check}>
                          {" · "}
                          <button
                            type="button"
                            class="usage-quota-check"
                            disabled={props.busy}
                            onClick={() => props.onCheck?.()}
                          >
                            {language.t("usage.quota.check")}
                          </button>
                        </Show>
                      </p>
                    )}
                  </Show>
                  <For each={entry.windows}>{(window) => {
                    const reset = createMemo(() => formatReset(window.resetsAt))
                    return (
                      <div class="usage-quota-window">
                        <div>
                          <span class="usage-quota-window-name">{say(window.name)}</span>
                          <span>
                            <b>{percentText(100 - window.percent)} left</b>
                            <Show when={reset()}> · resets {reset()}</Show>
                          </span>
                        </div>
                        <progress
                          max="100"
                          value={window.percent}
                          aria-label={`${entry.label} ${say(window.name)}: ${percentText(window.percent)} used`}
                        />
                      </div>
                    )
                  }}</For>
                </article>
              )}</For>
            </div>
          </section>
        )}</For>
      </Show>
    </section>
  )
}
