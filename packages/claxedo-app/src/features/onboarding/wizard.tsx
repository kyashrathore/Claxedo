import { createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { validWorktree } from "@/platform/sync/worktree"
import { animateHeightChanges } from "@/ui/controls/animate-height"
import { createProject, projectByCheckout, projectRequestCode, projectRequestMessage } from "./app-ports"
import { AiStep } from "./ai-step"
import { draftProjectName, type ProjectSource, type WizardDraft } from "./draft"
import { ExecutionStep, type ExecutionChoice } from "./execution-step"
import type { OnboardingFunnelEvent, OnboardingStepId } from "./funnel"
import { ProjectStep } from "./project-step"

const STEPS: ReadonlyArray<{
  id: OnboardingStepId
  label: string
  headline: string
  lede: (product: { localExecution: boolean }) => string
}> = [
  {
    id: "project",
    label: "Project",
    headline: "Start with a project",
    lede: (product) =>
      product.localExecution
        ? "Point Claxedo at a folder on this machine, or at a repository to clone. Where the work runs is a later question."
        : "Point Claxedo at a repository to clone. Where the work runs is a later question.",
  },
  {
    id: "ai",
    label: "AI",
    headline: "Connect an AI",
    lede: (product) =>
      product.localExecution
        ? "The agent runs on a login of yours. Anything found here can be changed later in Settings → Models."
        : "Cloud sandboxes here run Pi on a key of yours, stored on this deployment and handed to every sandbox you start. It can be changed later in Settings → Models.",
  },
  {
    id: "execution",
    label: "Where it runs",
    headline: "Where it runs",
    lede: (product) =>
      product.localExecution
        ? "Work runs on this machine unless you say otherwise."
        : "Work runs in a cloud sandbox this deployment provides, or on a machine you connect.",
  },
]

/**
 * The no-project screen: three questions, in the order they become
 * answerable, ending in a working session. It is the only first run on both
 * products and shows for one reason, that the server lists no project; once
 * one exists every later change is a Settings page.
 *
 * Nothing is created before Finish. A desktop's project is posted then, so a
 * clone that fails or a folder that is not a repository is answered on this
 * screen rather than after it; on the hosted plane Finish creates the first
 * cloud workspace, which is what a project is there.
 */
export const OnboardingWizard: Component<{
  baseUrl: string
  localExecution: boolean
  pickFolder?: () => Promise<string | undefined>
  emit: (event: OnboardingFunnelEvent) => void
  /** Handed the control that leads the current step, so the host can focus it. */
  leadField?: (element: HTMLElement) => void
  /** A desktop: the project Finish created; the host opens it. */
  onProjectCreated: (project: { id: string; worktree: string }) => void
  /** The hosted plane: the host creates the workspace from the draft and opens it. */
  createCloudWorkspace: (input: { projectName: string; source: ProjectSource }) => Promise<void>
  footer?: JSX.Element
}> = (props) => {
  const [step, setStep] = createSignal<OnboardingStepId>("project")
  // A step mounts on its first visit and stays mounted, hidden, so what the
  // user left in it — a chosen folder, a typed URL, a picked sandbox — is
  // there again when they come back to it.
  const [visited, setVisited] = createSignal<ReadonlySet<OnboardingStepId>>(new Set(["project"]))
  const goTo = (next: OnboardingStepId) => {
    setVisited((seen) => (seen.has(next) ? seen : new Set(seen).add(next)))
    setStep(next)
  }
  const [draft, setDraft] = createSignal<WizardDraft>()
  const [aiReady, setAiReady] = createSignal(false)
  const [chosen, setChosen] = createSignal<ExecutionChoice>()
  // Derived until the user picks: the server's word on local execution lands
  // after this mounts, and a hosted plane has no "this machine" row to hold.
  const choice = () => chosen() ?? (props.localExecution ? "local" : "cloud")
  const [executionReady, setExecutionReady] = createSignal(false)
  const [finishing, setFinishing] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let card!: HTMLDivElement
  let steps!: HTMLDivElement

  onMount(() => {
    props.emit({ name: "setup_form_shown" })
    // The card grows and shrinks with the step in it; the change is a motion,
    // not a cut.
    onCleanup(animateHeightChanges(card, [steps]))
  })

  const index = () => STEPS.findIndex((item) => item.id === step())
  const current = () => STEPS[index()] ?? STEPS[0]
  const projectName = () => {
    const held = draft()
    return held ? draftProjectName(held.source) : undefined
  }

  const advance = (from: OnboardingStepId) => {
    props.emit({ name: "step_done", step: from })
    setFailure(undefined)
    const next = STEPS[STEPS.findIndex((item) => item.id === from) + 1]
    if (next) goTo(next.id)
  }
  const back = () => {
    setFailure(undefined)
    const previous = STEPS[index() - 1]
    if (previous) goTo(previous.id)
  }

  const finish = async () => {
    const held = draft()
    if (!held || finishing()) return
    setFinishing(true)
    setFailure(undefined)
    try {
      if (props.localExecution) {
        const project = await createProject({ baseUrl: props.baseUrl, source: held.source }).catch(async (error: unknown) => {
          // A folder this server already holds as a project is that project:
          // open it rather than refuse, since picking it again says as much.
          if (held.source.kind !== "directory" || projectRequestCode(error) !== "project_directory_taken") throw error
          const existing = await projectByCheckout({ baseUrl: props.baseUrl, worktree: held.source.folder })
          if (!existing) throw error
          return existing
        })
        if (!project.checkoutDirectory || !validWorktree(project.checkoutDirectory)) {
          setFailure(`The project was created but its folder cannot be opened here: ${project.checkoutDirectory ?? "no checkout"}`)
          return
        }
        props.emit({ name: "step_done", step: "execution" })
        props.onProjectCreated({ id: project.id, worktree: project.checkoutDirectory })
        return
      }
      await props.createCloudWorkspace({ projectName: draftProjectName(held.source), source: held.source })
      props.emit({ name: "step_done", step: "execution" })
    } catch (error) {
      setFailure(projectRequestMessage(error))
    } finally {
      setFinishing(false)
    }
  }

  const nextDisabled = () => (step() === "ai" ? !aiReady() : !executionReady())
  const reason = () => {
    if (failure()) return failure()
    if (step() === "ai" && !aiReady()) {
      return props.localExecution
        ? "Connect a login above, or skip and connect at your first message."
        : "Save a key for one provider to continue."
    }
    if (step() === "execution" && !executionReady()) {
      if (choice() === "cloud") return "Save a sandbox key the provider accepts to finish here."
      return "Pick the cloud sandbox to finish; a connected machine cannot take this repository yet."
    }
    return undefined
  }
  const finishLabel = () => {
    if (finishing()) return props.localExecution ? "Creating project…" : "Creating workspace…"
    return props.localExecution ? "Open project" : "Create workspace"
  }

  return (
    <div class="flex min-h-0 flex-col" data-testid="onboarding-wizard" data-step={step()}>
      <ol class="first-project-steps first-project-reveal" aria-label="Setup steps">
        <For each={STEPS}>
          {(item, position) => (
            <li
              class="first-project-step"
              aria-current={item.id === step() ? "step" : undefined}
              data-done={position() < index()}
            >
              <span class="first-project-step-index">{position() + 1}</span>
              <span>{item.label}</span>
            </li>
          )}
        </For>
      </ol>
      <h1 class="first-project-headline first-project-reveal">{current().headline}</h1>
      <p class="first-project-lede first-project-reveal" style={{ "--first-project-delay": "40ms" }}>
        <Show when={step() !== "project" && projectName()}>
          {(name) => (
            <span class="first-project-project" data-slot="onboarding-project-name">
              {name()}
              <span aria-hidden="true"> · </span>
            </span>
          )}
        </Show>
        {current().lede({ localExecution: props.localExecution })}
      </p>
      <div class="first-project-card first-project-reveal" style={{ "--first-project-delay": "80ms" }} ref={card}>
        <div class="first-project-card-body" data-scrollable-pane data-slot="onboarding-card-body">
          <div data-slot="onboarding-card-steps" ref={steps}>
            <div hidden={step() !== "project"} data-step-panel="project">
              <ProjectStep
                baseUrl={props.baseUrl}
                localExecution={props.localExecution}
                {...(props.pickFolder ? { pickFolder: props.pickFolder } : {})}
                {...(props.leadField ? { leadField: props.leadField } : {})}
                onChosen={(source) => {
                  setDraft({ source })
                  advance("project")
                }}
              />
            </div>
            <Show when={visited().has("ai")}>
              <div hidden={step() !== "ai"} data-step-panel="ai">
                <AiStep localExecution={props.localExecution} onReady={setAiReady} />
              </div>
            </Show>
            <Show when={visited().has("execution")}>
              <div hidden={step() !== "execution"} data-step-panel="execution">
                <ExecutionStep
                  baseUrl={props.baseUrl}
                  localExecution={props.localExecution}
                  choice={choice()}
                  onChoice={setChosen}
                  onReady={setExecutionReady}
                />
              </div>
            </Show>
          </div>
        </div>
        <Show when={step() !== "project"}>
          <div
            class="mt-5 flex shrink-0 flex-wrap items-center gap-3 border-t border-border-weak-base pt-4"
            data-slot="onboarding-card-footer"
          >
            <p
              class={`min-w-0 flex-1 text-12-regular ${failure() ? "text-icon-warning-base" : "text-text-weak"}`}
              data-slot="onboarding-reason"
              role={failure() ? "alert" : undefined}
            >
              {reason() ?? ""}
            </p>
            <div class="flex shrink-0 items-center gap-2">
              <Button type="button" variant="ghost" size="normal" onClick={back} disabled={finishing()}>
                Back
              </Button>
              <Show when={step() === "ai" && props.localExecution && !aiReady()}>
                <Button type="button" variant="ghost" size="normal" onClick={() => advance("ai")}>
                  Skip for now
                </Button>
              </Show>
              <Show
                when={step() === "execution"}
                fallback={
                  <Button type="button" variant="primary" size="normal" disabled={nextDisabled()} onClick={() => advance("ai")}>
                    Next
                  </Button>
                }
              >
                <Button
                  type="button"
                  variant="primary"
                  size="normal"
                  disabled={nextDisabled() || finishing()}
                  onClick={() => void finish()}
                >
                  {finishLabel()}
                </Button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
      {props.footer}
    </div>
  )
}
