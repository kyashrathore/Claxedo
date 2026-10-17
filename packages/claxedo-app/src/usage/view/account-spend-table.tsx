import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { AccountSpendScope } from "@/server"
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
  const tokens = (row: SpendRow) => {
    const count = spendTokens(row)
    return count === undefined ? t("usage.unknown") : format.count(count)
  }
  return { name, detail, tokens }
}

export function AccountSpendTable(props: { readonly rows: readonly SpendRow[]; readonly scope: AccountSpendScope }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const words = useSpendRowWords()
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
        <For each={props.rows}>
          {(row) => (
            <tr>
              <th scope="row" class="usage-table-lead">
                <span class="usage-table-name" title={isStoredAccount(row.kind) ? row.id : undefined}>{words.name(row)}</span>
                <Show when={words.detail(row)}>{(detail) => <span class="usage-table-detail">{detail()}</span>}</Show>
              </th>
              <td>{format.whole(row.totals.turnCount)}</td>
              <td>{words.tokens(row)}</td>
              <td>{format.spend(costEstimate(row.cost, row.totals))}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
