import { For, onCleanup, onMount, Show } from "solid-js"
import { ProjectCreateForm } from "@/projects"
import { useServer, type Server } from "@/server"
import { animateHeightChanges, ScrollView } from "@/ui"
import { useOnboardingText } from "../i18n"
import type { ExecutionFacts } from "../model"
import { createOnboardingWizard, draftName, type OnboardingWizard as Wizard } from "../wizard"
import { AiStep } from "./ai-step"
import { ExecutionStep } from "./execution-step"
import { WizardFooter } from "./wizard-footer"

function prefetchLaterSteps(server: Server, localExecution: boolean) {
  const { accounts, integrations } = server.queries
  void server.queryClient.prefetchQuery(accounts.list())
  void server.queryClient.prefetchQuery(accounts.effective())
  void server.queryClient.prefetchQuery(accounts.sources())
  if (!localExecution) void server.queryClient.prefetchQuery(integrations.catalog())
}

function WizardSteps(props: { readonly wizard: Wizard }) {
  const t = useOnboardingText()
  return (
    <ol class="first-project-steps first-project-reveal" aria-label={t("onboarding.steps")}>
      <For each={props.wizard.steps()}>
        {(item, position) => (
          <li class="first-project-step" aria-current={item.id === props.wizard.step() ? "step" : undefined} data-done={position() < props.wizard.index()}>
            <span class="first-project-step-index">{position() + 1}</span>
            <span>{t(item.label)}</span>
          </li>
        )}
      </For>
    </ol>
  )
}

function WizardLede(props: { readonly wizard: Wizard }) {
  const t = useOnboardingText()
  const projectName = () => {
    const held = props.wizard.draft()
    return props.wizard.step() !== "project" && held ? draftName(held) : undefined
  }
  return (
    <p class="first-project-lede first-project-reveal" style={{ "--first-project-delay": "40ms" }}>
      <Show when={projectName()}>
        {(name) => (
          <span class="first-project-project">
            {name()}
            <span aria-hidden="true"> · </span>
          </span>
        )}
      </Show>
      {t(props.wizard.current().lede)}
    </p>
  )
}

function StepPanels(props: { readonly wizard: Wizard; readonly facts: ExecutionFacts; readonly pickFolder: () => Promise<string | undefined> }) {
  const wizard = () => props.wizard
  const t = useOnboardingText()
  return (
    <>
      <Show when={wizard().visited().has("project")}>
        <div hidden={wizard().step() !== "project"} data-step-panel="project">
          <ProjectCreateForm
            {...(props.facts.localExecution && props.facts.machineName ? { folderMachine: props.facts.machineName } : {})}
            namedByRepository={!props.facts.localExecution}
            pickFolder={props.pickFolder}
            submitLabel={t("onboarding.continue")}
            onSubmit={(source, name) => wizard().chooseSource({ source, ...(name ? { name } : {}) })}
          />
        </div>
      </Show>
      <Show when={wizard().visited().has("ai")}>
        <div hidden={wizard().step() !== "ai"} data-step-panel="ai">
          <AiStep onReady={wizard().setAiReady} />
        </div>
      </Show>
      <Show when={wizard().visited().has("execution")}>
        <div hidden={wizard().step() !== "execution"} data-step-panel="execution" inert={wizard().finish.working() || wizard().finish.created() !== undefined}>
          <ExecutionStep facts={props.facts} choice={wizard().choice()} onChoice={wizard().choose} size={wizard().size} />
        </div>
      </Show>
    </>
  )
}

export function OnboardingWizard(props: { readonly facts: ExecutionFacts; readonly pickFolder: () => Promise<string | undefined> }) {
  const t = useOnboardingText()
  const server = useServer()
  const wizard = createOnboardingWizard(() => props.facts)
  let card!: HTMLDivElement
  let steps!: HTMLDivElement
  onMount(() => {
    prefetchLaterSteps(server, props.facts.localExecution)
    onCleanup(animateHeightChanges(card, [steps]))
  })
  return (
    <div class="flex min-h-0 flex-col" data-testid="onboarding-wizard" data-step={wizard.step()}>
      <WizardSteps wizard={wizard} />
      <h1 class="first-project-headline first-project-reveal">{t(wizard.current().headline)}</h1>
      <WizardLede wizard={wizard} />
      <div class="first-project-card first-project-reveal" style={{ "--first-project-delay": "80ms" }} ref={card}>
        <ScrollView class="first-project-card-body">
          <div ref={steps}>
            <StepPanels wizard={wizard} facts={props.facts} pickFolder={props.pickFolder} />
          </div>
        </ScrollView>
        <Show when={wizard.step() !== "project" || wizard.index() > 0}>
          <WizardFooter wizard={wizard} localExecution={props.facts.localExecution} />
        </Show>
      </div>
    </div>
  )
}
