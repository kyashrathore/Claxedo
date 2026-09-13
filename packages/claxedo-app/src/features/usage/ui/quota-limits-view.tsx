import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, createMemo } from "solid-js"
import type { QuotaAccount, QuotaSnapshot } from "@claxedo/usage-contract"
import { harnessIcon, harnessLabel } from "@/platform/identity/harness-catalog"
import { useLanguage } from "@/platform/i18n/provider"
import {
  accountReach,
  AccountReachMarks,
  ACCOUNT_REACH_KEYS,
  CheckedAge,
  isRefusal,
  lastCheckedSentence,
  readAccountDelivery,
  VERDICT_KEY,
  WINDOW_KEY,
  type AccountReach,
} from "@/ui/controls/account-status"
import { formatCompactAge } from "@/lib/relative-time"
import { readPercent } from "@/lib/percent"

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
  label: Words
  plan?: string
  inUse: boolean
  /** Where the authority says a turn on this account can run, where anywhere. */
  reach?: AccountReach
  refusedKey?: string
  usageError?: string
  windows: Bar[]
  usageAt?: number
}
type Group = { key: string; name: Words; icon?: string; cards: Card[] }

/** The group every account no harness can run a turn on collects under. */
const OTHER_AGENTS = "other-agents"

function windowName(name: string): Words {
  const key = WINDOW_KEY[name]
  // A slot the vendor added since this dictionary was written still carries a
  // real figure, so it is drawn under the vendor's own name rather than dropped.
  return key === undefined ? { text: name.replaceAll("_", " ") } : { key }
}

function card(account: QuotaAccount, index: number): Card {
  const refusedKey = account.health !== undefined && isRefusal(account.health)
    ? VERDICT_KEY[account.health]
    : undefined
  const reach = accountReach(readAccountDelivery(account))
  return {
    key: account.credentialId ?? `${account.harness}-${index}`,
    harness: account.harness,
    // A harness login its CLI reports without an address is the only account
    // that names nothing, and it is always this computer's own.
    label: account.label === undefined
      ? { key: "settings.providers.agents.machineLogin" }
      : { text: account.label },
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    inUse: account.inUse,
    ...(reach === undefined ? {} : { reach }),
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
  /**
   * How long until a window comes back, in the one unit the line has room for.
   * Shorter than the smallest bucket, and already past it, are the same news.
   */
  const untilReset = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return undefined
    if (value <= Date.now()) return language.t("usage.quota.resetNow")
    return formatCompactAge(value) ?? language.t("usage.quota.resetNow")
  }
  const groups = createMemo(() => accountCards(props.snapshot))
  const summaryWords = createMemo(() => {
    const { constrainedWindow, remainingPercent, nearestReset, account } = quotaSummary(props.snapshot)
    if (constrainedWindow === undefined || remainingPercent === undefined) return undefined
    const summary = account === undefined
      ? language.t("usage.quota.summary", { percent: readPercent(remainingPercent), window: say(constrainedWindow) })
      : language.t("usage.quota.summaryForAccount", {
        percent: readPercent(remainingPercent),
        window: say(constrainedWindow),
        account: say(account),
      })
    const reset = untilReset(nearestReset)
    return reset === undefined ? summary : language.t("usage.quota.summaryReset", { summary, reset })
  })
  /** Whether a workspace in a cloud sandbox can run on this account at all. */
  const Reach = (self: { reach: AccountReach }) => (
    <Tooltip value={language.t(ACCOUNT_REACH_KEYS[self.reach].note)} placement="top">
      <AccountReachMarks reach={self.reach} component="usage-quota-reach" t={language.t} class="usage-quota-reach" />
    </Tooltip>
  )
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
        <div>
          <span class="usage-kicker">{language.t("usage.quota.kicker")}</span>
          <h3 id="usage-quota-title">{language.t("usage.quota.title")}</h3>
        </div>
      </div>
      <Show when={summaryWords()}>
        {(words) => <p class="usage-quota-summary">{words()}</p>}
      </Show>
      <Show
        when={groups().length}
        fallback={<div class="usage-chart-empty">{props.error ?? language.t("usage.quota.empty")}</div>}
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
                    <strong>{say(entry.label)}</strong>
                    <Show when={entry.plan}><span>{entry.plan}</span></Show>
                    <Show when={entry.inUse}>
                      <span class="usage-quota-in-use">{language.t("usage.quota.inUse")}</span>
                    </Show>
                    <Show when={entry.reach}>
                      {(reach) => <Reach reach={reach()} />}
                    </Show>
                    <Show when={entry.usageAt}>
                      {(at) => (
                        <Tooltip
                          value={lastCheckedSentence(language.t, at(), language.locale())}
                          placement="top"
                          class="usage-quota-as-of"
                        >
                          <CheckedAge
                            at={at()}
                            component="usage-quota-as-of"
                            t={language.t}
                            locale={language.locale()}
                          />
                        </Tooltip>
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
                    const reset = createMemo(() => untilReset(window.resetsAt))
                    return (
                      <div class="usage-quota-window">
                        <div>
                          <span class="usage-quota-window-name">{say(window.name)}</span>
                          <span>
                            <b>{language.t("usage.quota.windowLeft", { percent: readPercent(100 - window.percent) })}</b>
                            <Show when={reset()}>
                              {(value) => <>{" · "}{language.t("usage.quota.windowResets", { reset: value() })}</>}
                            </Show>
                          </span>
                        </div>
                        <progress
                          max="100"
                          value={window.percent}
                          aria-label={language.t("usage.quota.windowUsed", {
                            account: say(entry.label),
                            window: say(window.name),
                            percent: readPercent(window.percent),
                          })}
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
