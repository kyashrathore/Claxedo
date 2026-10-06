import { createMemo, createSignal, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { createMachineSizeChoice, type MachineSizeChoice } from "@/cloud"
import { draftProjectName, primaryPlacement } from "@/projects"
import { useServer } from "@/server"
import { draftPath } from "@/shell"
import { createFinish } from "./finish"
import { useOnboardingText } from "./i18n"
import { executionBlock, executionPlan, type ExecutionBlock, type ExecutionChoice, type ExecutionFacts, type OnboardingDraft } from "./model"
import { createOnboardingTarget, finishFailure, openedPlacement, openingDetail, startCreated, type Placing } from "./place"
import { createOnboardingFunnel, type OnboardingFunnel } from "./funnel"
import { onboardingSteps, type OnboardingStep, type OnboardingStepId } from "./steps"

export type FinishBlock = ExecutionBlock | "ai"

export function draftName(draft: OnboardingDraft): string {
  return draft.name ?? draftProjectName(draft.source)
}

function createStepper(steps: Accessor<readonly OnboardingStep[]>) {
  const first = steps()[0]?.id ?? "project"
  const [step, setStep] = createSignal<OnboardingStepId>(first)
  const [visited, setVisited] = createSignal<ReadonlySet<OnboardingStepId>>(new Set([first]))
  const goTo = (next: OnboardingStepId) => {
    setVisited((seen) => (seen.has(next) ? seen : new Set(seen).add(next)))
    setStep(next)
  }
  const index = () => steps().findIndex((item) => item.id === step())
  const current = () => steps()[index()] ?? steps()[0]
  const last = () => index() === steps().length - 1
  return { steps, step, visited, goTo, index, current, last }
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

function createExecution(facts: Accessor<ExecutionFacts>, draft: Accessor<OnboardingDraft | undefined>) {
  const [chosen, setChosen] = createSignal<ExecutionChoice>()
  const size: MachineSizeChoice | undefined = facts().localExecution ? undefined : createMachineSizeChoice()
  const choice = (): ExecutionChoice => chosen() ?? (facts().localExecution ? "local" : "cloud")
  const name = () => {
    const held = draft()
    return held ? draftName(held) : ""
  }
  return { choice, choose: setChosen, size, plan: createMemo(() => executionPlan(choice(), name(), size?.chosen())) }
}

export function createOnboardingWizard(facts: Accessor<ExecutionFacts>) {
  const stepper = createStepper(createMemo(() => onboardingSteps(facts().localExecution)))
  const [draft, setDraft] = createSignal<OnboardingDraft>()
  const [aiReady, setAiReady] = createSignal(false)
  const { plan, ...execution } = createExecution(facts, draft)
  const placing = () => {
    const held = draft()
    return held && { draft: held, plan: plan() }
  }
  const funnel = createOnboardingFunnel(useServer().telemetry, stepper.steps())
  const { finish, progress } = useOnboardingFinish(placing, funnel)
  const blocked = createMemo((): FinishBlock | undefined => executionBlock(plan(), facts(), draft()?.source) ?? (facts().localExecution || aiReady() ? undefined : "ai"))
  const move = (index: number) => {
    finish.moved()
    const target = stepper.steps()[index]
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
      move(stepper.index() + 1)
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
