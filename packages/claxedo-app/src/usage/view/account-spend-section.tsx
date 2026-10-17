import { createMemo, createSignal, createUniqueId, Match, Show, Switch, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import type { AccountSpendScope } from "@/server"
import { spendRow, spendScope, spendScopes } from "../account-spend"
import { useAccountSpend, useManagesTeamKeys, type AccountSpendRead } from "../api"
import { usageDictionary, type UsageKey } from "../i18n"
import type { UsageDays } from "../model"
import { AccountSpendTable } from "./account-spend-table"
import { Choices, type Choice } from "./choices"
import "./claxedo.css"

const SCOPE_WORDS: Readonly<Record<AccountSpendScope, UsageKey>> = { mine: "usage.accounts.scope.mine", org: "usage.accounts.scope.org" }

const EMPTY_WORDS: Readonly<Record<AccountSpendScope, UsageKey>> = { mine: "usage.accounts.empty.mine", org: "usage.accounts.empty.org" }

function SpendLoad(props: { readonly read: AccountSpendRead; readonly scope: AccountSpendScope }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const elapsed = useElapsed()
  const errorCopy = useErrorCopy("usage")
  const failed = () => {
    const load = props.read.load()
    return load.kind === "failed" ? load.error : undefined
  }
  const rows = createMemo(() => {
    const load = props.read.load()
    return load.kind === "ready" ? load.data.accounts.map(spendRow) : undefined
  })
  return (
    <Switch>
      <Match when={failed()}>
        {(error) => <FailureNotice title={t("usage.accounts.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => props.read.refresh()} />}
      </Match>
      <Match when={rows()}>
        {(ready) => (
          <Show when={ready().length > 0} fallback={<p class="usage-empty">{t(EMPTY_WORDS[props.scope])}</p>}>
            <AccountSpendTable rows={ready()} scope={props.scope} />
          </Show>
        )}
      </Match>
      <Match when={elapsed()}>
        <p class="usage-status" role="status">{t("usage.accounts.loading")}</p>
      </Match>
    </Switch>
  )
}

export function AccountSpendSection(props: { readonly days: UsageDays }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const titleId = createUniqueId()
  const managesTeamKeys = useManagesTeamKeys()
  const [chosen, setChosen] = createSignal<AccountSpendScope>("mine")
  const scope = () => spendScope(chosen(), managesTeamKeys())
  const choices = (): readonly Choice<AccountSpendScope>[] => spendScopes(managesTeamKeys()).map((value) => ({ value, label: SCOPE_WORDS[value] }))
  const read = useAccountSpend(() => props.days, scope)
  return (
    <section class="usage-breakdown" aria-labelledby={titleId}>
      <div class="usage-breakdown-head">
        <h3 id={titleId} class="usage-group-title">{t("usage.accounts")}</h3>
        <Show when={choices().length > 1}>
          <Choices label={t("usage.accounts.scope")} choices={choices()} value={scope()} onChange={setChosen} />
        </Show>
      </div>
      <SpendLoad read={read} scope={scope()} />
    </section>
  )
}
