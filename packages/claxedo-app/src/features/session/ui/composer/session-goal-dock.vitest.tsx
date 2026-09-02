import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import { SessionGoalDock } from "./session-goal-dock"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
  }),
}))

afterEach(cleanup)

const goal: RuntimeGoalSnapshot = {
  sessionId: "session-1",
  objective: "Ship when verification passes",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  iteration: 3,
}

const capabilities: AgentRuntimeGoalCapabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"],
  recovery: "reconcile",
  optionalFields: ["iteration"],
}

function renderDock(overrides?: Partial<Parameters<typeof SessionGoalDock>[0]>) {
  const noop = () => Promise.resolve()
  return render(() => (
    <DialogProvider>
      <SessionGoalDock
        goal={goal}
        capabilities={capabilities}
        onPause={noop}
        onResume={noop}
        onDelete={noop}
        {...overrides}
      />
    </DialogProvider>
  ))
}

describe("SessionGoalDock delete confirmation", () => {
  test("renders localized status and metrics instead of raw enums", () => {
    renderDock()
    expect(screen.getByText("session.goal.status.active")).toBeTruthy()
    expect(screen.getByText("session.goal.metric.iteration:3")).toBeTruthy()
  })

  test("shows the delete failure inside the confirmation dialog and supports retry", async () => {
    let attempts = 0
    const onDelete = vi.fn(() => {
      attempts += 1
      return attempts === 1
        ? Promise.reject(new Error("relay unavailable"))
        : Promise.resolve()
    })
    renderDock({ onDelete })

    fireEvent.click(screen.getByText("session.goal.delete"))
    await waitFor(() => expect(screen.getByText("session.goal.deleteTitle")).toBeTruthy())

    fireEvent.click(screen.getAllByText("session.goal.delete").at(-1)!)
    // The rejection must surface INSIDE the modal that owns the action, not
    // only behind it on the dock.
    await waitFor(() => {
      const dialog = screen.getByText("session.goal.deleteConfirm").closest("div")!
      expect(dialog.parentElement!.textContent).toContain("relay unavailable")
    })
    expect(screen.getByText("session.goal.deleteTitle")).toBeTruthy()

    // Retry from the same dialog succeeds and closes it.
    fireEvent.click(screen.getAllByText("session.goal.delete").at(-1)!)
    await waitFor(() => expect(screen.queryByText("session.goal.deleteTitle")).toBeNull())
    expect(onDelete).toHaveBeenCalledTimes(2)
  })
})
