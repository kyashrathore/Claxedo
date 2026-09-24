import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useOnboardingText, type OnboardingText } from "../i18n"
import type { OnboardingWizard } from "../wizard"

function reason(t: OnboardingText, wizard: OnboardingWizard, localExecution: boolean): string | undefined {
  const failure = wizard.failure()
  if (failure) return failure
  if (wizard.step() === "ai" && !wizard.aiReady()) return t(localExecution ? "onboarding.reason.ai.local" : "onboarding.reason.ai.hosted")
  if (wizard.step() === "execution" && !wizard.executionReady()) {
    return t(wizard.choice() === "cloud" ? "onboarding.reason.execution.cloud" : "onboarding.reason.execution.machine")
  }
  return undefined
}

function finishLabel(t: OnboardingText, finishing: boolean, localExecution: boolean): string {
  if (finishing) return t(localExecution ? "onboarding.finishing.local" : "onboarding.finishing.hosted")
  return t(localExecution ? "onboarding.finish.local" : "onboarding.finish.hosted")
}

export function WizardFooter(props: { readonly wizard: OnboardingWizard; readonly localExecution: boolean }) {
  const t = useOnboardingText()
  const wizard = () => props.wizard
  const nextDisabled = () => (wizard().step() === "ai" ? !wizard().aiReady() : !wizard().executionReady())
  return (
    <div class="mt-5 flex shrink-0 flex-wrap items-center gap-3 border-t border-border-weak-base pt-4" data-slot="onboarding-card-footer">
      <p
        class={`min-w-0 flex-1 text-12-regular ${wizard().failure() ? "text-icon-warning-base" : "text-text-weak"}`}
        data-slot="onboarding-reason"
        role={wizard().failure() ? "alert" : undefined}
      >
        {reason(t, wizard(), props.localExecution) ?? ""}
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" size="normal" onClick={() => wizard().back()} disabled={wizard().finishing()}>
          {t("onboarding.back")}
        </Button>
        <Show when={wizard().step() === "ai" && props.localExecution && !wizard().aiReady()}>
          <Button type="button" variant="ghost" size="normal" onClick={() => wizard().advance()}>
            {t("onboarding.skip")}
          </Button>
        </Show>
        <Show
          when={wizard().step() === "execution"}
          fallback={
            <Button type="button" variant="primary" size="normal" disabled={nextDisabled()} onClick={() => wizard().advance()}>
              {t("onboarding.next")}
            </Button>
          }
        >
          <Button type="button" variant="primary" size="normal" disabled={nextDisabled() || wizard().finishing()} onClick={() => void wizard().finish()}>
            {finishLabel(t, wizard().finishing(), props.localExecution)}
          </Button>
        </Show>
      </div>
    </div>
  )
}
