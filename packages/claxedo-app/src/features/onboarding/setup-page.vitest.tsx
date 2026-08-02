import { render, screen } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { SetupPage, type SetupPageStep } from "./setup-page"
import { setupStepLocation, stepPosition, type SetupStepView } from "./navigation"
import type { OnboardingStepId } from "./registry"

function step(id: OnboardingStepId, overrides: Partial<SetupPageStep> = {}): SetupPageStep {
  return {
    id,
    title: id,
    applies: true,
    done: false,
    locked: false,
    skipped: false,
    optional: false,
    ...overrides,
  }
}

function renderPage(props: Partial<Parameters<typeof SetupPage>[0]> = {}) {
  const steps = props.steps ?? [step("destination"), step("project"), step("ai")]
  return render(() => (
    <SetupPage
      steps={steps}
      location={props.location ?? setupStepLocation("destination")}
      title={props.title ?? "Where should your agents run?"}
      {...props}
    >
      {props.children ?? <div />}
    </SetupPage>
  ))
}

const nav = () => ({
  back: screen.getByRole("button", { name: "Back" }),
  next: screen.queryByRole("button", { name: /^(Next|Working…|Start your first task)$/ }),
  skip: screen.queryByRole("button", { name: /^Skip/ }),
})

describe("the setup nav row never changes shape", () => {
  test("Back and Next both render on the first step, with Back disabled", () => {
    // The owner asked "where is Back?" on step 1. It is present and inert, so
    // the row does not reflow as the user moves through the flow.
    renderPage()

    expect(nav().back).toBeDisabled()
    expect(nav().next).toBeInTheDocument()
  })

  test("Back is enabled once there is somewhere to go back to", () => {
    const back = vi.fn()
    renderPage({ location: setupStepLocation("project"), back })

    expect(nav().back).toBeEnabled()
    nav().back.click()
    expect(back).toHaveBeenCalled()
  })

  test("an unsatisfied step renders Next disabled, with a reason rather than nothing", () => {
    renderPage({
      primary: { label: "Next", disabled: true, hint: "Choose where your agents will run.", onClick: vi.fn() },
    })

    expect(nav().next).toBeDisabled()
    expect(nav().next).toHaveAttribute("title", "Choose where your agents will run.")
  })

  test("a satisfied step renders Next enabled and carrying no hint", () => {
    const onClick = vi.fn()
    renderPage({ primary: { label: "Next", disabled: false, onClick } })

    expect(nav().next).toBeEnabled()
    expect(nav().next).not.toHaveAttribute("title")
    nav().next!.click()
    expect(onClick).toHaveBeenCalled()
  })

  test("a screen with no primary at all still renders a disabled Next", () => {
    renderPage({ nextHint: "Finish this step to continue." })

    expect(nav().next).toBeDisabled()
    expect(nav().next).toHaveAttribute("title", "Finish this step to continue.")
  })

  test("Skip is the one conditional — absent unless skipping is a real choice", () => {
    renderPage()
    expect(nav().skip).not.toBeInTheDocument()

    renderPage({ skip: { label: "Skip — add compute later", onClick: vi.fn() } })
    expect(screen.getByRole("button", { name: "Skip — add compute later" })).toBeInTheDocument()
  })

  test("a busy primary says so and cannot be pressed twice", () => {
    const onClick = vi.fn()
    renderPage({ primary: { label: "Next", busy: true, onClick } })

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled()
  })
})

describe("the rail and the counter tell the same story", () => {
  const rail = () => Array.from(document.querySelectorAll(".setup-rail-segment"))
  const stateAt = (index: number) => rail()[index]?.getAttribute("data-state")

  test("the segment count matches the counter's total", () => {
    // Both halves must read the same list. home-view filters to applying steps
    // before passing them in; if that ever stops, this catches the divergence
    // the owner saw as "bar on 2, count on 1".
    const steps = [step("destination"), step("project"), step("ai")]
    renderPage({ steps })

    const position = stepPosition(steps as SetupStepView[], setupStepLocation("destination"))
    expect(rail()).toHaveLength(position!.total)
    expect(screen.getByText(`Step ${position!.index} of ${position!.total}`)).toBeInTheDocument()
  })

  test("a non-applying step is counted by neither half", () => {
    const steps = [step("destination"), step("project"), step("compute", { applies: false, optional: true })]
    renderPage({ steps: steps.filter((item) => item.applies), location: setupStepLocation("project") })

    expect(rail()).toHaveLength(2)
    expect(screen.getByText("Step 2 of 2")).toBeInTheDocument()
  })

  test("the highlighted segment is the current step, not a done step ahead of it", () => {
    // The defect the owner reported: a returning user's already-done project
    // step rendered solid while the current destination step animated dim, so
    // the middle segment read as active.
    renderPage({
      steps: [step("destination"), step("project", { done: true }), step("ai")],
      location: setupStepLocation("destination"),
    })

    expect(stateAt(0)).toBe("current")
    expect(stateAt(1)).not.toBe("done")
  })

  test("segments before the current one read as done", () => {
    renderPage({
      steps: [step("destination", { done: true }), step("project"), step("ai")],
      location: setupStepLocation("project"),
    })

    expect(stateAt(0)).toBe("done")
    expect(stateAt(1)).toBe("current")
    expect(stateAt(2)).toBe("upcoming")
  })
})
