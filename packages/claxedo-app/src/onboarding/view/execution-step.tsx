import { For, Show } from "solid-js"
import type { MachineSizeChoice } from "@/cloud"
import { useOnboardingText, type OnboardingKey, type OnboardingText } from "../i18n"
import { executionChoices, type ExecutionChoice, type ExecutionFacts } from "../model"
import { ChoiceRow } from "./choice-row"
import { CloudPlacement } from "./cloud-placement"

const ROW_DETAIL: Record<ExecutionChoice, OnboardingKey> = {
  local: "onboarding.execution.local.detail",
  cloud: "onboarding.execution.cloud.detail",
}

function choiceTitle(t: OnboardingText, id: ExecutionChoice, facts: ExecutionFacts): string {
  return id === "local" ? facts.machineName ?? t("onboarding.execution.local.loading") : t("onboarding.execution.cloud.title")
}

export function ExecutionStep(props: {
  readonly facts: ExecutionFacts
  readonly choice: ExecutionChoice
  readonly onChoice: (choice: ExecutionChoice) => void
  readonly size: MachineSizeChoice | undefined
}) {
  const t = useOnboardingText()
  return (
    <Show when={props.facts.localExecution} fallback={<CloudPlacement facts={props.facts} size={props.size} />}>
      <div role="radiogroup" aria-label={t("onboarding.execution.label")} class="flex flex-col gap-2">
        <For each={executionChoices(props.facts)}>
          {(id) => <ChoiceRow checked={props.choice === id} title={choiceTitle(t, id, props.facts)} detail={t(ROW_DETAIL[id])} onChoose={() => props.onChoice(id)} />}
        </For>
      </div>
    </Show>
  )
}
