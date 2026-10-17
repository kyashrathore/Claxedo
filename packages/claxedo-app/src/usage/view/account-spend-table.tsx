import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { AccountSpendScope, MemberSpend, SpendingMember } from "@/server"
import { ClaxedoIcon } from "@/ui"
import { spendTokens, type SpendRow, type SpendRowKind } from "../account-spend"
import { costEstimate } from "../cost-estimate"
import { usageDictionary, type UsageKey } from "../i18n"
import { useUsageFormats } from "./usage-formats"

const KIND_WORDS: Readonly<Record<SpendRowKind, UsageKey>> = {
  plan: "usage.accounts.kind.plan",
  apiKey: "usage.accounts.kind.apiKey",
  teamKey: "usage.accounts.kind.teamKey",
  otherMember: "usage.accounts.otherMember",
  machine: "usage.accounts.machine",
  unresolved: "usage.accounts.unresolved",
  unreported: "usage.accounts.unreported",
}

const TABLE_NAMES: Readonly<Record<AccountSpendScope, UsageKey>> = { mine: "usage.accounts.table.mine", org: "usage.accounts.table.org" }

const MEMBER_WORDS: Readonly<Record<Exclude<SpendingMember["kind"], "named">, UsageKey>> = {
  unnamed: "usage.accounts.member.unnamed",
  former: "usage.accounts.member.former",
}

function isStoredAccount(kind: SpendRowKind): boolean {
  return kind === "plan" || kind === "apiKey" || kind === "teamKey"
}

function useSpendRowWords() {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const name = (row: SpendRow) => {
    if (!isStoredAccount(row.kind)) return t(KIND_WORDS[row.kind])
    return row.label ?? row.vendor ?? t("usage.accounts.removed")
  }
  const detail = (row: SpendRow) => (isStoredAccount(row.kind) ? [row.vendor, t(KIND_WORDS[row.kind])].filter(Boolean).join(" · ") : undefined)
  const tokens = (row: Pick<SpendRow, "totals">) => {
    const count = spendTokens(row)
    return count === undefined ? t("usage.unknown") : format.count(count)
  }
  const member = (spend: MemberSpend) => (spend.member.kind === "named" ? spend.member.name : t(MEMBER_WORDS[spend.member.kind]))
  return { name, detail, tokens, member }
}

function SpendFigures(props: { readonly row: Pick<SpendRow, "totals" | "cost"> }): JSX.Element {
  const format = useUsageFormats()
  const words = useSpendRowWords()
  return (
    <>
      <td>{format.whole(props.row.totals.turnCount)}</td>
      <td>{words.tokens(props.row)}</td>
      <td>{format.spend(costEstimate(props.row.cost, props.row.totals))}</td>
    </>
  )
}

function MemberRows(props: { readonly members: readonly MemberSpend[]; readonly id: string }): JSX.Element {
  const words = useSpendRowWords()
  return (
    <For each={props.members}>
      {(spend, index) => (
        <tr class="usage-table-member" id={index() === 0 ? props.id : undefined}>
          <th scope="row" class="usage-table-lead">
            <span class="usage-table-name" title={spend.memberId}>{words.member(spend)}</span>
          </th>
          <SpendFigures row={spend} />
        </tr>
      )}
    </For>
  )
}

function AccountRows(props: { readonly row: SpendRow }): JSX.Element {
  const words = useSpendRowWords()
  const membersId = createUniqueId()
  const [expanded, setExpanded] = createSignal(false)
  const members = () => props.row.members ?? []
  const name = () => <span class="usage-table-name" title={isStoredAccount(props.row.kind) ? props.row.id : undefined}>{words.name(props.row)}</span>
  return (
    <>
      <tr>
        <th scope="row" class="usage-table-lead">
          <Show when={members().length > 0} fallback={name()}>
            <button type="button" class="usage-table-toggle" aria-expanded={expanded()} aria-controls={membersId} onClick={() => setExpanded(!expanded())}>
              <ClaxedoIcon name="chevron-right" size="small" class="usage-table-chevron" />
              {name()}
            </button>
          </Show>
          <Show when={words.detail(props.row)}>{(detail) => <span class="usage-table-detail">{detail()}</span>}</Show>
        </th>
        <SpendFigures row={props.row} />
      </tr>
      <Show when={expanded()}>
        <MemberRows members={members()} id={membersId} />
      </Show>
    </>
  )
}

export function AccountSpendTable(props: { readonly rows: readonly SpendRow[]; readonly scope: AccountSpendScope }): JSX.Element {
  const t = useTranslator(usageDictionary)
  return (
    <table class="usage-table" aria-label={t(TABLE_NAMES[props.scope])}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.accounts.account")}</th>
          <th scope="col">{t("usage.totals.turns")}</th>
          <th scope="col">{t("usage.totals.tokens")}</th>
          <th scope="col">{t("usage.totals.cost")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>{(row) => <AccountRows row={row} />}</For>
      </tbody>
    </table>
  )
}
