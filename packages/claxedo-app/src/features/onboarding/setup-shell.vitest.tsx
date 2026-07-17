import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import { SetupShell, type SetupShellStepView } from "./setup-shell"
import { onboardingGoFurtherCards } from "./go-further"

const steps: SetupShellStepView[] = [
  { id: "project", title: "Open a project", education: "Give your agent a codebase.", done: true, locked: false },
  { id: "ai", title: "Connect your AI", education: "Use a provider you already trust.", done: false, locked: false },
  {
    id: "compute",
    title: "Add compute",
    education: "Keep agents running in the cloud.",
    done: false,
    locked: true,
    lockedReason: "Available after your first task",
  },
  {
    id: "remote-access",
    title: "Access remotely",
    education: "Check in from another device.",
    done: false,
    locked: true,
    lockedReason: "Enable remote access first",
  },
]

describe("SetupShell", () => {
  test("renders every step, its active implementation, and inert locked rows", () => {
    const onSelectStep = vi.fn()
    render(() => (
      <SetupShell
        mode="form"
        steps={steps}
        activeStep="ai"
        onSelectStep={onSelectStep}
        onDismiss={() => undefined}
        onSkip={() => undefined}
        renderStep={(id) => <div>shared content: {id}</div>}
      />
    ))

    expect(screen.getAllByRole("listitem")).toHaveLength(4)
    expect(screen.getByText("shared content: ai")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add compute/i })).toBeDisabled()
    expect(screen.getByText("Available after your first task")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /connect your ai/i }))
    expect(onSelectStep).toHaveBeenCalledWith("ai")
  })

  test("reacts to a locked-to-unlocked transition without remounting", () => {
    const [locked, setLocked] = createSignal(true)
    const onSelectStep = vi.fn()
    render(() => (
      <SetupShell
        mode="form"
        steps={[{ ...steps[2], locked: locked() }]}
        activeStep={locked() ? undefined : "compute"}
        onSelectStep={onSelectStep}
        onDismiss={() => undefined}
        onSkip={() => undefined}
        renderStep={(id) => <div>shared content: {id}</div>}
      />
    ))

    expect(screen.getByRole("button", { name: /add compute/i })).toBeDisabled()
    setLocked(false)
    expect(screen.getByRole("button", { name: /add compute/i })).toBeEnabled()
    expect(screen.getByText("shared content: compute")).toBeInTheDocument()
  })

  test("collapses to the checklist without losing step truth", () => {
    render(() => (
      <SetupShell
        mode="checklist"
        steps={steps}
        activeStep="ai"
        onSelectStep={() => undefined}
        onDismiss={() => undefined}
        onSkip={() => undefined}
        renderStep={() => undefined}
      />
    ))

    expect(screen.getByRole("heading", { name: "Finish setup" })).toBeInTheDocument()
    expect(screen.getByText("1 of 4 proven")).toBeInTheDocument()
    expect(screen.queryByTestId("setup-content-pane")).not.toBeInTheDocument()
  })

  test("renders individually dismissible go-further cards", () => {
    const onDismiss = vi.fn()
    render(() => (
      <SetupShell
        mode="go-further"
        steps={steps}
        activeStep="compute"
        goFurtherCards={onboardingGoFurtherCards}
        dismissedCards={["self-host"]}
        onSelectStep={() => undefined}
        onDismiss={() => undefined}
        onSkip={() => undefined}
        onDismissCard={onDismiss}
        renderStep={() => undefined}
      />
    ))

    expect(screen.getByRole("heading", { name: "Go further" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Organize work with WorkGraph" })).toBeInTheDocument()
    expect(screen.queryByText("Deploy on your own infrastructure")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Organize work with WorkGraph" }))
    expect(onDismiss).toHaveBeenCalledWith("workgraph")
  })
})
