import { For, Show, type JSX } from "solid-js"
import type { OnboardingStepId } from "./registry"
import type { OnboardingGoFurtherCard, OnboardingGoFurtherCardId } from "./go-further"
import type { SetupShellMode } from "./setup-shell-state"
import "./setup-shell.css"

export type SetupShellStepView = {
  id: OnboardingStepId
  title: string
  education: string
  done: boolean
  locked: boolean
  lockedReason?: string
  skippable?: boolean
}

export function SetupShell(props: {
  mode: Exclude<SetupShellMode, "hidden">
  steps: SetupShellStepView[]
  activeStep?: OnboardingStepId
  goFurtherCards?: readonly OnboardingGoFurtherCard[]
  dismissedCards?: OnboardingGoFurtherCardId[]
  onSelectStep: (id: OnboardingStepId) => void
  onDismiss: () => void
  onSkip: (id: OnboardingStepId) => void
  onSelectCard?: (id: OnboardingGoFurtherCardId) => void
  onDismissCard?: (id: OnboardingGoFurtherCardId) => void
  renderStep: (id: OnboardingStepId) => JSX.Element
}) {
  const completed = () => props.steps.filter((step) => step.done).length

  return (
    <Show
      when={props.mode !== "go-further"}
      fallback={
        <section class="onboarding-go-further" aria-labelledby="onboarding-go-further-title">
          <div class="onboarding-shell-heading">
            <div>
              <h2 id="onboarding-go-further-title" class="text-16-medium text-text-strong">
                Go further
              </h2>
              <p class="text-12-regular text-text-weak">Your first task worked. These are ready when you are.</p>
            </div>
          </div>
          <div class="onboarding-go-further-grid">
            <For each={(props.goFurtherCards ?? []).filter((card) => !props.dismissedCards?.includes(card.id))}>
              {(card) => (
                <article class="onboarding-go-further-card">
                  <div class="onboarding-go-further-card-head">
                    <h3 class="text-14-medium text-text-strong">{card.title}</h3>
                    <button
                      type="button"
                      class="onboarding-quiet-action"
                      aria-label={`Dismiss ${card.title}`}
                      onClick={() => props.onDismissCard?.(card.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                  <p class="text-12-regular text-text-weak">{card.education}</p>
                  <button
                    type="button"
                    class="onboarding-primary-action"
                    onClick={() => props.onSelectCard?.(card.id)}
                  >
                    {card.action}
                  </button>
                </article>
              )}
            </For>
          </div>
        </section>
      }
    >
      <section
        class="onboarding-shell"
        classList={{ "is-checklist": props.mode === "checklist" }}
        aria-labelledby="onboarding-shell-title"
      >
        <div class="onboarding-shell-heading">
          <div>
            <h2 id="onboarding-shell-title" class="text-16-medium text-text-strong">
              {props.mode === "checklist" ? "Finish setup" : "Set up Claxedo"}
            </h2>
            <p class="text-12-regular text-text-weak">
              {props.mode === "checklist" ? `${completed()} of ${props.steps.length} proven` : "Start a real task in a few minutes."}
            </p>
          </div>
          <button type="button" class="onboarding-quiet-action" onClick={props.onDismiss}>
            {props.mode === "checklist" ? "Hide" : "Do this later"}
          </button>
        </div>

        <div class="onboarding-shell-body">
          <ol class="onboarding-step-list">
            <For each={props.steps}>
              {(step) => (
                <li class="onboarding-step-row" classList={{ "is-active": props.activeStep === step.id, "is-done": step.done }}>
                  <button
                    type="button"
                    class="onboarding-step-button"
                    aria-label={step.title}
                    disabled={step.locked}
                    onClick={() => props.onSelectStep(step.id)}
                  >
                    <span class="onboarding-step-marker" aria-hidden="true">
                      {step.done ? "✓" : step.locked ? "—" : ""}
                    </span>
                    <span class="onboarding-step-copy">
                      <span class="text-13-medium text-text-strong">{step.title}</span>
                      <span class="text-12-regular text-text-weak">{step.locked ? step.lockedReason : step.education}</span>
                    </span>
                  </button>
                  <Show when={props.mode === "form" && step.skippable && !step.done && !step.locked}>
                    <button type="button" class="onboarding-skip-action" onClick={() => props.onSkip(step.id)}>
                      Skip for now
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ol>
          <Show when={props.mode === "form" && props.activeStep}>
            {(id) => (
              <div class="onboarding-content-pane" data-testid="setup-content-pane">
                {props.renderStep(id())}
              </div>
            )}
          </Show>
        </div>
      </section>
    </Show>
  )
}
