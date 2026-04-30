import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => <span data-testid="icon" />,
}))

import { WorkspaceCreateFlow } from "./workspace-create-flow"

afterEach(() => {
  cleanup()
})

describe("WorkspaceCreateFlow", () => {
  test("shows back button when provided and calls it", () => {
    const onBack = vi.fn()
    const { getByText } = render(() => (
      <WorkspaceCreateFlow
        project={{ id: "p-1", name: "Alpha", worktree: "/repo/main" }}
        projectName="Alpha"
        onBack={onBack}
      />
    ))

    fireEvent.click(getByText("New workspace").previousElementSibling as HTMLElement)
    expect(onBack).toHaveBeenCalledOnce()
  })

  test("runs local create flow with typed workspace name", async () => {
    const onCreateLocal = vi.fn(async (_project, onProgress, workspaceName) => {
      onProgress?.("creating")
      onProgress?.("ready")
      onProgress?.("redirecting")
      expect(workspaceName).toBe("feature-auth")
    })
    const onComplete = vi.fn()

    const { getByText, getByPlaceholderText } = render(() => (
      <WorkspaceCreateFlow
        project={{ id: "p-1", name: "Alpha", worktree: "/repo/main" }}
        projectName="Alpha"
        canCreateCloud
        initialType="local"
        onCreateLocal={onCreateLocal}
        onComplete={onComplete}
      />
    ))

    fireEvent.click(getByText("Local"))
    fireEvent.input(getByPlaceholderText("e.g. feature-auth, staging"), {
      currentTarget: { value: "feature-auth" },
      target: { value: "feature-auth" },
    })
    fireEvent.click(getByText("Create"))

    await waitFor(() => {
      expect(onCreateLocal).toHaveBeenCalledOnce()
      expect(onComplete).toHaveBeenCalledOnce()
    })
  })

  test("hides cloud option when cloud creation is unavailable", () => {
    const { queryByText } = render(() => (
      <WorkspaceCreateFlow
        project={{ id: "p-1", name: "Alpha", worktree: "/repo/main" }}
        projectName="Alpha"
        canCreateCloud={false}
      />
    ))

    expect(queryByText("Cloud")).toBeNull()
  })
})
