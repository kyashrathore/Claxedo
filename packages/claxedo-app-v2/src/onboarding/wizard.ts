import { createSignal, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useCloudPlacer } from "@/cloud"
import { draftProjectName, primaryPlacement } from "@/projects"
import { createOrOpenFolderProject, toAppError, useServer, type PlacementId, type ProjectSource } from "@/server"
import { draftPath } from "@/shell"
import { useOnboardingText } from "./i18n"
import { onboardingSteps, type ExecutionChoice, type OnboardingStepId } from "./steps"

export type OnboardingDraft = { readonly source: ProjectSource; readonly name?: string }

export function draftName(draft: OnboardingDraft): string {
  return draft.name ?? draftProjectName(draft.source)
}

function createStepper() {
  const [step, setStep] = createSignal<OnboardingStepId>("project")
  const [visited, setVisited] = createSignal<ReadonlySet<OnboardingStepId>>(new Set(["project"]))
  const goTo = (next: OnboardingStepId) => {
    setVisited((seen) => (seen.has(next) ? seen : new Set(seen).add(next)))
    setStep(next)
  }
  const index = () => onboardingSteps.findIndex((item) => item.id === step())
  const current = () => onboardingSteps[index()] ?? onboardingSteps[0]
  return { step, visited, goTo, index, current }
}

function usePlaceProject(localExecution: Accessor<boolean>): (draft: OnboardingDraft) => Promise<PlacementId> {
  const server = useServer()
  const cloud = useCloudPlacer()
  const t = useOnboardingText()
  return async (draft) => {
    const input = { source: draft.source, ...(draft.name ? { name: draft.name } : {}) }
    if (!localExecution()) {
      const project = await server.projects.create(input)
      return (await cloud.create({ projectId: project.id })).id
    }
    const project = await createOrOpenFolderProject(server, input)
    const placement = primaryPlacement(server.placements.list(), project.id)
    if (!placement) throw new Error(t("onboarding.failed.noPlacement", { project: project.name }))
    return placement.id
  }
}

function createFinisher(localExecution: Accessor<boolean>, draft: Accessor<OnboardingDraft | undefined>) {
  const place = usePlaceProject(localExecution)
  const navigate = useNavigate()
  const [finishing, setFinishing] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const finish = async () => {
    const held = draft()
    if (!held || finishing()) return
    setFinishing(true)
    setFailure(undefined)
    try {
      navigate(draftPath(await place(held)))
    } catch (error) {
      setFailure(toAppError(error).message)
    } finally {
      setFinishing(false)
    }
  }
  return { finishing, failure, setFailure, finish }
}

export function createOnboardingWizard(localExecution: Accessor<boolean>) {
  const stepper = createStepper()
  const [draft, setDraft] = createSignal<OnboardingDraft>()
  const [aiReady, setAiReady] = createSignal(false)
  const [chosen, setChosen] = createSignal<ExecutionChoice>()
  const [executionReady, setExecutionReady] = createSignal(false)
  const finisher = createFinisher(localExecution, draft)
  const move = (index: number) => {
    finisher.setFailure(undefined)
    const target = onboardingSteps[index]
    if (target) stepper.goTo(target.id)
  }
  return {
    ...stepper,
    ...finisher,
    draft,
    aiReady,
    setAiReady,
    executionReady,
    setExecutionReady,
    choice: (): ExecutionChoice => chosen() ?? (localExecution() ? "local" : "cloud"),
    choose: setChosen,
    chooseSource: (source: OnboardingDraft) => {
      setDraft(source)
      move(1)
    },
    advance: () => move(stepper.index() + 1),
    back: () => move(stepper.index() - 1),
  }
}

export type OnboardingWizard = ReturnType<typeof createOnboardingWizard>
