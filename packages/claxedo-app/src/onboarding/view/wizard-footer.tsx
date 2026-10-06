import { Show } from "solid-js"
import { useOnboardingText, type OnboardingKey, type OnboardingText } from "../i18n"
import type { FinishBlock, OnboardingWizard } from "../wizard"
import { Button } from "@/ui"

const BLOCK_TEXT: Record<FinishBlock, OnboardingKey> = {
  signIn: "onboarding.reason.execution.signIn",
  folder: "onboarding.reason.execution.folder",
  ai: "onboarding.reason.ai.hosted",
}

function blockedReason(t: OnboardingText, wizard: OnboardingWizard, localExecution: boolean): string | undefined {
  const failure = wizard.finish.failure()
  if (failure) return failure
  const progress = wizard.progress()
  if (progress) return progress
  if (wizard.step() === "ai" && !wizard.aiReady()) return t(localExecution ? "onboarding.reason.ai.local" : "onboarding.reason.ai.hosted")
  const blocked = wizard.blocked()
  if (wizard.last() && blocked && !wizard.finish.created()) return t(BLOCK_TEXT[blocked])
  return undefined
}

function finishLabel(t: OnboardingText, wizard: OnboardingWizard, localExecution: boolean): string {
  const created = wizard.finish.created()
  const working = wizard.finish.working()
  if (created?.kind === "project") return t(working ? "onboarding.opening" : "onboarding.open.project")
  if (created?.kind === "workspace") return t(working ? "onboarding.opening" : "onboarding.open.workspace")
  const project = created === undefined && localExecution && wizard.choice() !== "cloud"
  if (working) return t(project ? "onboarding.finishing.project" : "onboarding.finishing.workspace")
  return t(project ? "onboarding.finish.project" : "onboarding.finish.workspace")
}

function FinishButton(props: { readonly wizard: OnboardingWizard; readonly localExecution: boolean }) {
  const t = useOnboardingText()
  const finish = () => props.wizard.finish
  const disabled = () => finish().working() || finish().finished() || (!finish().created() && props.wizard.blocked() !== undefined)
  return (
    <Button type="button" variant="contrast" size="normal" disabled={disabled()} onClick={() => props.wizard.complete()}>
      {finishLabel(t, props.wizard, props.localExecution)}
    </Button>
  )
}

export function WizardFooter(props: { readonly wizard: OnboardingWizard; readonly localExecution: boolean }) {
  const t = useOnboardingText()
  const wizard = () => props.wizard
  const committed = () => wizard().finish.working() || wizard().finish.created() !== undefined
  return (
    <div class="mt-5 flex shrink-0 flex-wrap items-center gap-3 border-t border-border-weak-base pt-4">
      <p
        class={`min-w-0 flex-1 text-12-regular ${wizard().finish.failure() ? "text-icon-warning-base" : "text-text-weak"}`}
        role={wizard().finish.failure() ? "alert" : undefined}
      >
        {blockedReason(t, wizard(), props.localExecution) ?? ""}
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <Show when={wizard().index() > 0}>
          <Button type="button" variant="ghost" size="normal" onClick={() => wizard().back()} disabled={committed()}>
            {t("onboarding.back")}
          </Button>
        </Show>
        <Show when={wizard().step() === "ai" && props.localExecution && !wizard().aiReady()}>
          <Button type="button" variant="ghost" size="normal" onClick={() => wizard().advance()}>
            {t("onboarding.skip")}
          </Button>
        </Show>
        <Show when={wizard().step() !== "project"}>
          <Show
            when={wizard().last()}
            fallback={
              <Button type="button" variant="contrast" size="normal" disabled={wizard().step() === "ai" && !wizard().aiReady()} onClick={() => wizard().advance()}>
                {t("onboarding.next")}
              </Button>
            }
          >
            <FinishButton wizard={wizard()} localExecution={props.localExecution} />
          </Show>
        </Show>
      </div>
    </div>
  )
}
