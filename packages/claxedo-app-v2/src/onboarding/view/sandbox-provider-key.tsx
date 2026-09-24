import { For, Show } from "solid-js"
import { SandboxDriverLogo } from "@/cloud"
import type { SandboxProviderOption, SandboxProviderVerification } from "@/server"
import { useOnboardingText, type OnboardingText } from "../i18n"
import { canSaveSandboxKey, createSandboxKey, type SandboxKey } from "../sandbox-key"
import { Button } from "@/ui"

function verdictText(t: OnboardingText, provider: SandboxProviderOption, verdict: SandboxProviderVerification): string {
  if (verdict.state === "working") return t("onboarding.sandbox.working", { provider: provider.label })
  if (verdict.state === "broken") return verdict.reason ?? t("onboarding.sandbox.broken", { provider: provider.label })
  return verdict.reason ?? t("onboarding.sandbox.unknown", { provider: provider.label })
}

function ProviderPicker(props: { readonly sandbox: SandboxKey }) {
  const t = useOnboardingText()
  return (
    <div role="radiogroup" aria-label={t("onboarding.sandbox.label")} class="flex flex-wrap gap-2">
      <For each={props.sandbox.providers()}>
        {(provider) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.sandbox.selected()?.id === provider.id}
            data-provider={provider.id}
            class="flex items-center gap-2 rounded-md border border-border-base px-2.5 py-1.5 text-13-regular text-text-strong hover:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
            onClick={() => props.sandbox.pick(provider.id)}
          >
            <SandboxDriverLogo id={provider.id} label={provider.label} class="size-4 shrink-0" />
            <span>{provider.label}</span>
            <Show when={provider.configured}>
              <span class="text-11-medium text-text-weak">{t("onboarding.sandbox.saved")}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

function KeyForm(props: { readonly sandbox: SandboxKey; readonly provider: SandboxProviderOption }) {
  const t = useOnboardingText()
  const sandbox = () => props.sandbox
  const saveLabel = () => (sandbox().busy() ? t("onboarding.sandbox.checking") : props.provider.configured ? t("onboarding.sandbox.replace") : t("onboarding.sandbox.save"))
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void sandbox().save()
      }}
    >
      <For each={props.provider.fields}>
        {(field) => (
          <label class="flex flex-col gap-1">
            <span class="text-12-medium text-text-weak">{field.label}</span>
            <input
              type={field.secret ? "password" : "text"}
              value={sandbox().values()[field.key] ?? ""}
              onInput={(event) => sandbox().setValues({ ...sandbox().values(), [field.key]: event.currentTarget.value })}
              aria-label={field.label}
              autocomplete="off"
              spellcheck={false}
              class="h-9 w-full min-w-0 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular text-text-strong focus:outline-none focus:border-border-interactive-base"
            />
          </label>
        )}
      </For>
      <div class="flex items-center gap-3">
        <Button type="submit" variant="secondary" size="small" disabled={sandbox().busy() || !canSaveSandboxKey(props.provider, sandbox().values())}>
          {saveLabel()}
        </Button>
        <Show when={sandbox().verdict()}>
          {(verdict) => (
            <span class="text-12-regular text-text-weak" data-slot="onboarding-sandbox-verdict" data-state={verdict().state}>
              {verdictText(t, props.provider, verdict())}
            </span>
          )}
        </Show>
      </div>
      <Show when={sandbox().failure()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {sandbox().failure()}
        </p>
      </Show>
    </form>
  )
}

export function SandboxProviderKey(props: { readonly onReady: (ready: boolean) => void }) {
  const t = useOnboardingText()
  const sandbox = createSandboxKey((ready) => props.onReady(ready))
  return (
    <div class="flex flex-col gap-3" data-slot="onboarding-sandbox-key">
      <Show when={sandbox.loading()}>
        <span class="text-12-regular text-text-weak">{t("onboarding.sandbox.loading")}</span>
      </Show>
      <Show when={sandbox.unavailable()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {t("onboarding.sandbox.unmanaged")}
        </p>
      </Show>
      <Show when={sandbox.providers().length > 0}>
        <ProviderPicker sandbox={sandbox} />
      </Show>
      <Show when={sandbox.selected()}>{(provider) => <KeyForm sandbox={sandbox} provider={provider()} />}</Show>
    </div>
  )
}
