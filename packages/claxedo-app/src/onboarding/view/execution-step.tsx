import { For, Show } from "solid-js"
import { TextField } from "@/ui"
import { useOnboardingText, type OnboardingKey } from "../i18n"
import { executionChoices, type ExecutionChoice, type ExecutionFacts } from "../model"

const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

const ROW_TEXT: Record<ExecutionChoice, { readonly title: OnboardingKey; readonly detail: OnboardingKey }> = {
  local: { title: "onboarding.execution.local.title", detail: "onboarding.execution.local.detail" },
  cloud: { title: "onboarding.execution.cloud.title", detail: "onboarding.execution.cloud.detail" },
  connected: { title: "onboarding.execution.connected.title", detail: "onboarding.execution.connected.detail" },
}

function ConnectMachine(props: { readonly localExecution: boolean }) {
  const t = useOnboardingText()
  return (
    <div class="flex flex-col gap-3">
      <p class="text-13-regular text-text-weak">{t("onboarding.execution.machine.intro")}</p>
      <TextField label={t("onboarding.execution.machine.invite")} value={INVITE_COMMAND} readOnly copyable />
      <TextField label={t("onboarding.execution.machine.connect")} value={CONNECT_COMMAND} readOnly copyable />
      <p class="text-12-regular text-text-weak">{t(props.localExecution ? "onboarding.execution.machine.local" : "onboarding.execution.machine.hosted")}</p>
    </div>
  )
}

export function ExecutionStep(props: { readonly facts: ExecutionFacts; readonly choice: ExecutionChoice; readonly onChoice: (choice: ExecutionChoice) => void }) {
  const t = useOnboardingText()
  return (
    <div class="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("onboarding.execution.label")} class="flex flex-col gap-2">
        <For each={executionChoices(props.facts)}>
          {(id) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.choice === id}
              data-choice={id}
              class="flex flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
              onClick={() => props.onChoice(id)}
            >
              <span class="text-14-medium text-text-strong">{t(ROW_TEXT[id].title)}</span>
              <span class="text-12-regular text-text-weak">{t(ROW_TEXT[id].detail)}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.choice === "cloud" && props.facts.cloudAvailable}>
        <p class="text-13-regular text-text-weak">{t("onboarding.execution.cloud.note")}</p>
      </Show>
      <Show when={props.choice === "connected"}>
        <ConnectMachine localExecution={props.facts.localExecution} />
      </Show>
    </div>
  )
}
