import { Show } from "solid-js"
import { ClaxedoIcon } from "@/ui"
import { offersCloudChoice } from "../account-words"
import { useAccountsText } from "../i18n"
import type { AccountsSnapshot, Harness } from "../model"
import type { Accounts } from "../store"
import { LabelHint } from "./account-actions"
import { useAccountRows } from "./account-rows"

function ChoiceHint(props: { readonly harness: Harness; readonly snapshot: AccountsSnapshot; readonly accounts: Accounts }) {
  const t = useAccountsText()
  const rows = useAccountRows(() => props.harness, () => props.snapshot, () => props.accounts)
  const note = () => t("settings.providers.agents.cloudChoiceShared", { vendor: props.harness.vendor })
  return (
    <Show when={offersCloudChoice(props.snapshot.cloudOnly, rows())}>
      <LabelHint value={note()}>
        <ClaxedoIcon name="help" size="small" class="icon-weak-base" role="img" aria-hidden="false" aria-label={note()} />
      </LabelHint>
    </Show>
  )
}

export function CloudChoiceHint(props: { readonly harness: Harness; readonly accounts: Accounts }) {
  const snapshot = () => {
    const load = props.accounts.load()
    return load.kind === "ready" ? load.snapshot : undefined
  }
  return <Show when={snapshot()}>{(current) => <ChoiceHint harness={props.harness} snapshot={current()} accounts={props.accounts} />}</Show>
}
