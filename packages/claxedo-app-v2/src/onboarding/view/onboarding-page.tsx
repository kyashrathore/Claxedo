import { createMemo, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { unreachable } from "@/lib/machine"
import { AddProjectSteps, draftProjectName, useAddProjectFlow, usePlacementOpener } from "@/projects"
import { useServer } from "@/server"
import type { PageProps } from "@/shell"
import { useOnboardingText, type OnboardingText } from "../i18n"
import { onboardingCurrentStep, onboardingState, onboardingStepIndex, onboardingSteps, type OnboardingStep } from "../model"
import { animateHeightChanges } from "./card-height"
import "./onboarding.css"

function stepLabel(t: OnboardingText, step: OnboardingStep): string {
  switch (step) {
    case "project":
      return t("onboarding.step.project")
    case "agent":
      return t("onboarding.step.ai")
    case "placement":
      return t("onboarding.step.placement")
    default:
      return unreachable(step)
  }
}

function headline(t: OnboardingText, step: OnboardingStep): string {
  switch (step) {
    case "project":
      return t("onboarding.project.headline")
    case "agent":
      return t("onboarding.ai.headline")
    case "placement":
      return t("onboarding.placement.headline")
    default:
      return unreachable(step)
  }
}

function lede(t: OnboardingText, step: OnboardingStep, onMachine: boolean): string {
  switch (step) {
    case "project":
      return onMachine ? t("onboarding.project.lede.machine") : t("onboarding.project.lede.hosted")
    case "agent":
      return t("onboarding.ai.lede")
    case "placement":
      return onMachine ? t("onboarding.placement.lede.machine") : t("onboarding.placement.lede.hosted")
    default:
      return unreachable(step)
  }
}

export const OnboardingPage: Component<PageProps> = () => {
  const t = useOnboardingText()
  const server = useServer()
  const flow = useAddProjectFlow(usePlacementOpener().openCreated)
  const state = createMemo(() => onboardingState(flow.state()))
  const step = () => onboardingCurrentStep(state())
  const index = () => onboardingStepIndex(state())
  const onMachine = () => server.capabilities()?.thisMachine !== undefined
  const projectName = () => {
    const source = flow.draft.source
    if (!source || state().kind === "project") return undefined
    return flow.draft.name.trim() || draftProjectName(source)
  }
  let card!: HTMLDivElement
  let panels!: HTMLDivElement
  onMount(() => onCleanup(animateHeightChanges(card, [panels])))

  return (
    <main class="onboarding" data-testid="onboarding" data-step={state().kind}>
      <div class="onboarding-content">
        <ol class="onboarding-steps onboarding-reveal" aria-label={t("onboarding.steps")}>
          <For each={onboardingSteps}>
            {(item, position) => (
              <li aria-current={item === step() ? "step" : undefined} data-done={position() < index()}>
                <span class="onboarding-step-index">{position() + 1}</span>
                <span>{stepLabel(t, item)}</span>
              </li>
            )}
          </For>
        </ol>
        <h1 class="onboarding-headline onboarding-reveal">{headline(t, step())}</h1>
        <p class="onboarding-lede onboarding-reveal" style={{ "--onboarding-delay": "40ms" }}>
          <Show when={projectName()}>
            {(name) => (
              <span data-slot="onboarding-project-name">
                {name()}
                <span aria-hidden="true"> · </span>
              </span>
            )}
          </Show>
          {lede(t, step(), onMachine())}
        </p>
        <div class="onboarding-card onboarding-reveal" style={{ "--onboarding-delay": "80ms" }} ref={card}>
          <AddProjectSteps flow={flow} panelsRef={(element) => (panels = element)} />
        </div>
      </div>
    </main>
  )
}
