import { For, Show } from "solid-js"
import { useConnectMachine } from "@/settings"
import { Button, TextField } from "@/ui"
import { useOnboardingText, type OnboardingKey, type OnboardingText } from "../i18n"
import { executionChoices, offersConnectMachine, type ExecutionChoice, type ExecutionFacts } from "../model"

const ROW_DETAIL: Record<ExecutionChoice, OnboardingKey> = {
  local: "onboarding.execution.local.detail",
  cloud: "onboarding.execution.cloud.detail",
}

const ROW_CLASS =
  "flex w-full flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active aria-expanded:border-border-interactive-base"

function ConnectMachine() {
  const t = useOnboardingText()
  const connect = useConnectMachine()
  return (
    <Button type="button" variant="ghost" size="small" icon="plus" class="self-start" onClick={connect}>
      {t("onboarding.execution.connect")}
    </Button>
  )
}

function choiceTitle(t: OnboardingText, id: ExecutionChoice, facts: ExecutionFacts): string {
  return id === "local" ? facts.machineName ?? t("onboarding.execution.local.loading") : t("onboarding.execution.cloud.title")
}

export function ExecutionStep(props: {
  readonly facts: ExecutionFacts
  readonly choice: ExecutionChoice
  readonly onChoice: (choice: ExecutionChoice) => void
  readonly workspaceName: string
  readonly onWorkspaceName: (name: string) => void
}) {
  const t = useOnboardingText()
  return (
    <div class="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("onboarding.execution.label")} class="flex flex-col gap-2">
        <For each={executionChoices(props.facts)}>
          {(id) => (
            <button type="button" role="radio" aria-checked={props.choice === id} data-choice={id} class={ROW_CLASS} onClick={() => props.onChoice(id)}>
              <span class="text-14-medium text-text-strong">{choiceTitle(t, id, props.facts)}</span>
              <span class="text-12-regular text-text-weak">{t(ROW_DETAIL[id])}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.choice === "cloud" && props.facts.cloudAvailable}>
        <TextField label={t("onboarding.execution.cloud.name")} value={props.workspaceName} onChange={props.onWorkspaceName} required spellcheck={false} />
      </Show>
      <Show when={offersConnectMachine(props.facts)}>
        <ConnectMachine />
      </Show>
    </div>
  )
}
