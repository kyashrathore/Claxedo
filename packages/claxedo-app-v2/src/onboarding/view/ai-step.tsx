import { Spinner } from "@opencode-ai/ui/spinner"
import { createEffect, For, Show } from "solid-js"
import { AgentHarnessAccounts, harnesses, useAccounts } from "@/accounts"
import { useOnboardingText } from "../i18n"

function Scanning() {
  const t = useOnboardingText()
  return (
    <p class="flex items-center gap-2 py-2 text-12-regular text-text-weak" data-slot="onboarding-ai-scanning">
      <Spinner class="size-4" />
      <span>{t("onboarding.ai.scanning")}</span>
    </p>
  )
}

export function AiStep(props: { readonly localExecution: boolean; readonly onReady: (ready: boolean) => void }) {
  const t = useOnboardingText()
  const accounts = useAccounts()
  createEffect(() => props.onReady(accounts.runnable()))
  return (
    <div class="flex flex-col gap-4" data-slot="onboarding-ai-logins">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span class="text-12-medium text-text-weak">{t("onboarding.ai.logins")}</span>
      </div>
      <Show when={accounts.opened()} fallback={<Scanning />}>
        <div class="flex flex-col gap-6">
          <For each={harnesses}>{(harness) => <AgentHarnessAccounts harness={harness} accounts={accounts} />}</For>
        </div>
      </Show>
    </div>
  )
}
