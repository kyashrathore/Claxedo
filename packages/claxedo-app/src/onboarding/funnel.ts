import { onCleanup } from "solid-js"
import type { ProductTelemetry } from "@/server"
import type { OnboardingStep, OnboardingStepId } from "./steps"

export type OnboardingFunnel = {
  readonly moved: (from: OnboardingStepId, to: OnboardingStepId) => void
  readonly finished: () => void
}

export function createOnboardingFunnel(telemetry: ProductTelemetry, steps: readonly OnboardingStep[]): OnboardingFunnel {
  const stepIndex = (step: OnboardingStepId) => steps.findIndex((item) => item.id === step)
  const first = steps[0]?.id ?? "project"
  let current = first
  let done = false
  const viewed = (step: OnboardingStepId) => telemetry.record({ event: "onboarding_step_viewed", properties: { step } })
  const completed = (step: OnboardingStepId) => telemetry.record({ event: "onboarding_step_completed", properties: { step } })
  viewed(first)
  onCleanup(() => {
    if (!done) telemetry.record({ event: "onboarding_abandoned", properties: { step: current } })
  })
  return {
    moved: (from, to) => {
      if (from === to) return
      if (stepIndex(to) > stepIndex(from)) completed(from)
      current = to
      viewed(to)
    },
    finished: () => {
      if (done) return
      done = true
      completed(current)
    },
  }
}
