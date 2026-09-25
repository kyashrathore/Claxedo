import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { TextField } from "@/ui"
import { useOnboardingText, type OnboardingText } from "../i18n"
import type { ExecutionChoice } from "../steps"
import { SandboxProviderKey } from "./sandbox-provider-key"

const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

type ExecutionRow = { readonly id: ExecutionChoice; readonly title: string; readonly detail: string }

function executionRows(t: OnboardingText, localExecution: boolean): ExecutionRow[] {
  const local: ExecutionRow = { id: "local", title: t("onboarding.execution.local.title"), detail: t("onboarding.execution.local.detail") }
  return [
    ...(localExecution ? [local] : []),
    {
      id: "cloud",
      title: t("onboarding.execution.cloud.title"),
      detail: t(localExecution ? "onboarding.execution.cloud.detail.local" : "onboarding.execution.cloud.detail.hosted"),
    },
    { id: "connected", title: t("onboarding.execution.connected.title"), detail: t("onboarding.execution.connected.detail") },
  ]
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

export function ExecutionStep(props: {
  readonly localExecution: boolean
  readonly choice: ExecutionChoice
  readonly onChoice: (choice: ExecutionChoice) => void
  readonly onReady: (ready: boolean) => void
}) {
  const t = useOnboardingText()
  const [keyReady, setKeyReady] = createSignal(false)
  const ready = createMemo(() => {
    if (props.choice === "local") return true
    if (props.choice === "cloud") return !props.localExecution || keyReady()
    return props.localExecution
  })
  createEffect(() => props.onReady(ready()))
  return (
    <div class="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("onboarding.execution.label")} class="flex flex-col gap-2">
        <For each={executionRows(t, props.localExecution)}>
          {(row) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.choice === row.id}
              data-choice={row.id}
              class="flex flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
              onClick={() => props.onChoice(row.id)}
            >
              <span class="text-14-medium text-text-strong">{row.title}</span>
              <span class="text-12-regular text-text-weak">{row.detail}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.choice === "cloud"}>
        <Show when={props.localExecution} fallback={<p class="text-13-regular text-text-weak">{t("onboarding.execution.cloud.hosted")}</p>}>
          <SandboxProviderKey onReady={setKeyReady} />
        </Show>
      </Show>
      <Show when={props.choice === "connected"}>
        <ConnectMachine localExecution={props.localExecution} />
      </Show>
    </div>
  )
}
