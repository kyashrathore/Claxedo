/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ProductEvent } from "@/server"
import { createOnboardingFunnel, type OnboardingFunnel } from "./funnel"

function walk(steps: (funnel: OnboardingFunnel) => void) {
  const recorded: ProductEvent[] = []
  createRoot((dispose) => {
    steps(createOnboardingFunnel({ record: (event) => void recorded.push(event) }, "project"))
    dispose()
  })
  return recorded.map((event) => [event.event, Object.values(event.properties)[0]])
}

test("a finished run views and completes each step it passes, and is not abandoned", () => {
  expect(walk((funnel) => {
    funnel.moved("project", "ai")
    funnel.moved("ai", "execution")
    funnel.finished()
  })).toEqual([
    ["onboarding_step_viewed", "project"],
    ["onboarding_step_completed", "project"],
    ["onboarding_step_viewed", "ai"],
    ["onboarding_step_completed", "ai"],
    ["onboarding_step_viewed", "execution"],
    ["onboarding_step_completed", "execution"],
  ])
})

test("going back completes nothing, and leaving unfinished is abandoned at the step left on", () => {
  expect(walk((funnel) => {
    funnel.moved("project", "ai")
    funnel.moved("ai", "project")
  })).toEqual([
    ["onboarding_step_viewed", "project"],
    ["onboarding_step_completed", "project"],
    ["onboarding_step_viewed", "ai"],
    ["onboarding_step_viewed", "project"],
    ["onboarding_abandoned", "project"],
  ])
})
