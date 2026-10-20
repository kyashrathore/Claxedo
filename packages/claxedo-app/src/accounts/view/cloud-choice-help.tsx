import { createSignal, For, Show } from "solid-js"
import { useI18n } from "@/i18n"
import { ClaxedoIcon, Popover } from "@/ui"
import { cloudChoiceWords, offersCloudChoice } from "../account-words"
import { useAccountsText } from "../i18n"
import type { AccountsSnapshot, Harness } from "../model"
import type { Accounts } from "../store"
import { useAccountRows } from "./account-rows"

function ChoiceHelp(props: { readonly harness: Harness; readonly snapshot: AccountsSnapshot; readonly accounts: Accounts }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const rows = useAccountRows(() => props.harness, () => props.snapshot, () => props.accounts)
  const words = () => cloudChoiceWords(t, props.harness, i18n.intlTag())
  const [open, setOpen] = createSignal(false)
  return (
    <Show when={offersCloudChoice(props.snapshot.cloudOnly, rows())}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="bottom-start"
        title={words().title}
        triggerAs="button"
        triggerProps={{
          type: "button",
          "aria-label": words().trigger,
          class: "flex size-8 items-center justify-center rounded-md border-none bg-transparent p-0 hover:bg-surface-base-hover pointer-coarse:size-11",
        }}
        trigger={<ClaxedoIcon name="help" size="small" class="icon-weak-base" />}
      >
        <ul class="m-0 flex list-disc flex-col gap-1.5 pl-4 text-12-regular leading-[18px] text-text-base">
          <For each={words().lines}>{(line) => <li>{line}</li>}</For>
        </ul>
      </Popover>
    </Show>
  )
}

export function CloudChoiceHelp(props: { readonly harness: Harness; readonly accounts: Accounts }) {
  const snapshot = () => {
    const load = props.accounts.load()
    return load.kind === "ready" ? load.snapshot : undefined
  }
  return <Show when={snapshot()}>{(current) => <ChoiceHelp harness={props.harness} snapshot={current()} accounts={props.accounts} />}</Show>
}
