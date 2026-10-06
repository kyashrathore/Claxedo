import { createMemo, createSignal, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { draftProjectName, primaryPlacement } from "@/projects"
import { useServer } from "@/server"
import { draftPath } from "@/shell"
import { createFinish } from "./finish"
import { useOnboardingText } from "./i18n"
import { executionBlock, executionPlan, type ExecutionChoice, type ExecutionFacts, type OnboardingDraft } from "./model"
import { createOnboardingTarget, finishFailure, openedPlacement, openingDetail, startCreated, type Placing } from "./place"
import { createOnboardingFunnel, type OnboardingFunnel } from "./funnel"
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

function useOnboardingFinish(placing: Accessor<Placing | undefined>, funnel: OnboardingFunnel) {
  const server = useServer()
  const navigate = useNavigate()
  const t = useOnboardingText()
  const held = () => {
    const current = placing()
    if (!current) throw new Error("Finish ran before the project step chose a source")
    return current
  }
  const finish = createFinish({
    create: (hold) => createOnboardingTarget(server, t, held(), hold),
    open: async (created) => {
      await startCreated(server, created)
      funnel.finished()
      navigate(draftPath(openedPlacement(t, created, (project) => primaryPlacement(server.placements.list(), project)?.id)))
    },
    describe: (error, created) => finishFailure(t, error, created),
  })
  const progress = () => {
    const created = finish.created()
    return created?.kind === "workspace" && finish.working() ? openingDetail(t, server.cloud.runtime(created.placementId)) : undefined
  }
  return { finish, progress }
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
  const funnel = createOnboardingFunnel(useServer().telemetry, stepper.step())
  const { finish, progress } = useOnboardingFinish(placing, funnel)
  const blocked = createMemo(() => executionBlock(plan(), facts(), draft()?.source))
  const move = (index: number) => {
    finish.moved()
    const target = onboardingSteps[index]
    if (!target) return
    funnel.moved(stepper.step(), target.id)
    stepper.goTo(target.id)
  }
  return {
    ...stepper,
    finish,
    progress,
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
