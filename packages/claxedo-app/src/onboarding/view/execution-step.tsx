import { createSignal, For, Show } from "solid-js"
import { MachineConnectSteps } from "@/settings"
import { TextField } from "@/ui"
import { useOnboardingText, type OnboardingKey } from "../i18n"
import { executionChoices, offersConnectComputer, type ExecutionChoice, type ExecutionFacts } from "../model"

const ROW_TEXT: Record<ExecutionChoice, { readonly title: OnboardingKey; readonly detail: OnboardingKey }> = {
  local: { title: "onboarding.execution.local.title", detail: "onboarding.execution.local.detail" },
  cloud: { title: "onboarding.execution.cloud.title", detail: "onboarding.execution.cloud.detail" },
}

const ROW_CLASS =
  "flex w-full flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active aria-expanded:border-border-interactive-base"

function ConnectComputer() {
  const t = useOnboardingText()
  const [open, setOpen] = createSignal(false)
  return (
    <div class="flex flex-col gap-3">
      <button type="button" class={ROW_CLASS} aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="text-14-medium text-text-strong">{t("onboarding.execution.connect.title")}</span>
        <span class="text-12-regular text-text-weak">{t("onboarding.execution.connect.detail")}</span>
      </button>
      <Show when={open()}>
        <MachineConnectSteps />
      </Show>
    </div>
  )
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
              <span class="text-14-medium text-text-strong">{t(ROW_TEXT[id].title)}</span>
              <span class="text-12-regular text-text-weak">{t(ROW_TEXT[id].detail)}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.choice === "cloud" && props.facts.cloudAvailable}>
        <TextField label={t("onboarding.execution.cloud.name")} value={props.workspaceName} onChange={props.onWorkspaceName} required spellcheck={false} />
      </Show>
      <Show when={offersConnectComputer(props.facts)}>
        <ConnectComputer />
      </Show>
    </div>
  )
}
