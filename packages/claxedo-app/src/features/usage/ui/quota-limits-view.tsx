import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { For, Show, createMemo } from "solid-js"
import type { QuotaAccount, QuotaSnapshot } from "@claxedo/usage-contract"
import { harnessIcon, harnessLabel } from "@/platform/identity/harness-catalog"
import { formatRelativeTime } from "@/lib/relative-time"

type Bar = { label: string; percent: number; resetsAt: number | null }
type Card = {
  key: string
  harness: string
  label: string
  plan?: string
  inUse: boolean
  refused?: string
  windows: Bar[]
  usageAt?: number
  /** Said where a harness reports a login it can name no plan figures for. */
  unreadable: boolean
}
type Group = { harness: string; name: string; icon: string; cards: Card[] }

/** The vendor slot names the verifier normalises to, in the reader's words. */
const WINDOW_LABELS: Record<string, string> = {
  session: "Session",
  weekly: "Weekly",
  weekly_opus: "Weekly · Opus",
}

/** The verdicts only a different account, or a fresh login, can answer. */
const REFUSALS: Record<string, string> = {
  auth_failed: "Rejected by the provider",
  no_billing: "No active billing",
  expired: "Expired",
}

/**
 * The harnesses whose own CLI answers with a login and no plan figures. Claude
 * Code has no headless usage read at all, so its card would otherwise read as a
 * plan nobody had got around to checking rather than one that cannot be read.
 */
const USAGE_UNREADABLE = new Set(["claude"])

function windowLabel(name: string) {
  return WINDOW_LABELS[name] ?? name.replaceAll("_", " ")
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
  const refused = account.health === undefined ? undefined : REFUSALS[account.health]
  return {
    key: account.credentialId ?? `machine-${account.harness}-${index}`,
    harness: account.harness,
    // A harness login its CLI reports without an address is the only account
    // that names nothing, and it is always this computer's own.
    label: account.label ?? "This computer's login",
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    inUse: account.inUse,
    ...(refused === undefined ? {} : { refused }),
    // A refusal outranks whatever the plan last read: the account cannot spend
    // it until it is reconnected, so the bars would be answering another
    // question than the card is.
    windows: refused
      ? []
      : account.windows.map((window) => ({
        label: windowLabel(window.window),
        percent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
        resetsAt: window.resetsAt,
      })),
    ...(account.usageAt === undefined ? {} : { usageAt: account.usageAt }),
    unreadable: refused === undefined
      && account.windows.length === 0
      && account.machineLogin === true
      && USAGE_UNREADABLE.has(account.harness),
  }
}

/** One card per account, under the harness that runs it, in the snapshot's order. */
export function accountCards(snapshot: QuotaSnapshot | undefined): Group[] {
  const groups: Group[] = []
  for (const [index, account] of (snapshot?.accounts ?? []).entries()) {
    const entry = card(account, index)
    const held = groups.find((group) => group.harness === entry.harness)
    if (held) {
      held.cards.push(entry)
      continue
    }
    groups.push({
      harness: entry.harness,
      name: harnessLabel(entry.harness) ?? entry.harness,
      icon: harnessIcon(entry.harness),
      cards: [entry],
    })
  }
  return groups
}

/** The line above the cards: the tightest window across the accounts in use. */
export function quotaSummary(snapshot: QuotaSnapshot | undefined) {
  const cards = accountCards(snapshot).flatMap((group) => group.cards).filter((entry) => entry.inUse)
  const windows = cards.flatMap((entry) => entry.windows)
  const constrained = windows.toSorted((a, b) => b.percent - a.percent)[0]
  const nearestReset = windows
    .map((window) => window.resetsAt)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .toSorted((a, b) => a - b)[0]
  return {
    accountCount: cards.length,
    constrainedLabel: constrained?.label,
    remainingPercent: constrained ? 100 - constrained.percent : undefined,
    nearestReset,
  }
}

export function QuotaLimitsView(props: { status: string; snapshot?: QuotaSnapshot; error?: string }) {
  const groups = createMemo(() => accountCards(props.snapshot))
  const summaryWords = createMemo(() => {
    const { constrainedLabel, remainingPercent, nearestReset } = quotaSummary(props.snapshot)
    if (constrainedLabel === undefined || remainingPercent === undefined) return undefined
    const reset = formatReset(nearestReset)
    return `${remainingPercent}% left on ${constrainedLabel}${reset ? `, back in ${reset}` : ""}`
  })
  return (
    <section class="usage-quota" aria-labelledby="usage-quota-title">
      <div class="usage-section-heading">
        <div><span class="usage-kicker">From your connected accounts</span><h3 id="usage-quota-title">Quota windows</h3></div>
        <span class="usage-source-state" data-state={props.status}>{props.status}</span>
      </div>
      <Show when={summaryWords()}>
        {(words) => <p class="usage-quota-summary">{words()}</p>}
      </Show>
      <Show
        when={groups().length}
        fallback={<div class="usage-chart-empty">{props.error ?? "No connected account reports a plan here."}</div>}
      >
        <For each={groups()}>{(group) => (
          <section class="usage-quota-harness" aria-label={group.name}>
            <h4>
              <ProviderIcon id={group.icon} class="size-4 shrink-0 icon-strong-base" />
              {group.name}
            </h4>
            <div class="usage-quota-grid">
              <For each={group.cards}>{(entry) => (
                <article
                  class="usage-quota-account"
                  data-account={entry.key}
                  data-refused={entry.refused === undefined ? undefined : "true"}
                >
                  <header>
                    <strong>{entry.label}</strong>
                    <Show when={entry.plan}><span>{entry.plan}</span></Show>
                    <Show when={entry.inUse}><span class="usage-quota-in-use">In use</span></Show>
                  </header>
                  <Show when={entry.refused}>
                    {(refused) => <p class="usage-quota-account-note">{refused()}</p>}
                  </Show>
                  <Show when={entry.unreadable}>
                    <p class="usage-quota-account-note">Usage not readable for this login</p>
                  </Show>
                  <Show when={!entry.refused && !entry.unreadable && entry.windows.length === 0}>
                    <p class="usage-quota-account-note">No plan usage has been read for this account</p>
                  </Show>
                  <For each={entry.windows}>{(window) => {
                    const reset = createMemo(() => formatReset(window.resetsAt))
                    const read = createMemo(() =>
                      entry.usageAt === undefined ? undefined : formatRelativeTime(entry.usageAt))
                    return (
                      <div class="usage-quota-window">
                        <div>
                          <span class="usage-quota-window-name">{window.label}</span>
                          <span>
                            <b>{100 - window.percent}% left</b>
                            <Show when={reset()}> · resets {reset()}</Show>
                            <Show when={read()}> · as of {read()}</Show>
                          </span>
                        </div>
                        <progress
                          max="100"
                          value={window.percent}
                          aria-label={`${entry.label} ${window.label}: ${window.percent}% used`}
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
