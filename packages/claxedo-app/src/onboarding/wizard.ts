import { createMemo, createSignal, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { draftProjectName, primaryPlacement } from "@/projects"
import { useServer } from "@/server"
import { draftPath } from "@/shell"
import { createFinish } from "./finish"
import { useOnboardingText } from "./i18n"
import { executionBlock, executionPlan, type ExecutionChoice, type ExecutionFacts, type OnboardingDraft } from "./model"
import { createOnboardingTarget, finishFailure, openedPlacement, startCreated, type Placing } from "./place"
import { onboardingSteps, type OnboardingStepId } from "./steps"

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

function useOnboardingFinish(placing: Accessor<Placing | undefined>) {
  const server = useServer()
  const navigate = useNavigate()
  const t = useOnboardingText()
  const held = () => {
    const current = placing()
    if (!current) throw new Error("Finish ran before the project step chose a source")
    return current
  }
  return createFinish({
    create: (hold) => createOnboardingTarget(server, t, held(), hold),
    open: async (created) => {
      await startCreated(server, created)
      navigate(draftPath(openedPlacement(t, created, (project) => primaryPlacement(server.placements.list(), project)?.id)))
    },
    describe: (error, created) => finishFailure(t, error, created),
  })
}

function createExecution(facts: Accessor<ExecutionFacts>) {
  const [chosen, setChosen] = createSignal<ExecutionChoice>()
  const [workspaceName, setWorkspaceName] = createSignal("")
  const choice = (): ExecutionChoice => chosen() ?? (facts().localExecution ? "local" : "cloud")
  return { choice, choose: setChosen, workspaceName, setWorkspaceName, plan: createMemo(() => executionPlan(choice(), workspaceName())) }
}

export function createOnboardingWizard(facts: Accessor<ExecutionFacts>) {
  const stepper = createStepper()
  const [draft, setDraft] = createSignal<OnboardingDraft>()
  const [aiReady, setAiReady] = createSignal(false)
  const { plan, ...execution } = createExecution(facts)
  const placing = () => {
    const held = draft()
    return held && { draft: held, plan: plan() }
  }
  const finish = useOnboardingFinish(placing)
  const blocked = createMemo(() => executionBlock(plan(), facts(), draft()?.source))
  const move = (index: number) => {
    finish.moved()
    const target = onboardingSteps[index]
    if (target) stepper.goTo(target.id)
  }
  return {
    ...stepper,
    finish,
    draft,
    aiReady,
    setAiReady,
    blocked,
    ...execution,
    chooseSource: (source: OnboardingDraft) => {
      setDraft(source)
      move(1)
    },
    advance: () => move(stepper.index() + 1),
    back: () => move(stepper.index() - 1),
    complete: () => {
      if (!placing() || (!finish.created() && blocked())) return
      void finish.run()
    },
  }
}

export type OnboardingWizard = ReturnType<typeof createOnboardingWizard>
