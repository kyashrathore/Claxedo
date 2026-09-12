import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { EMPTY_CONFIGURATION } from "@claxedo/tasks/solid"

const state = vi.hoisted(() => ({ projects: [] as { id: string; name: string; worktree: string }[] }))

vi.mock("@/app/providers/global-sync/provider", () => ({
  useQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: () => Promise.resolve(state.projects) }),
  }),
}))

vi.mock("@/features/session/composer/ui/harness-controller", () => ({
  usePromptHarnessControllersOptional: () => ({ submit: {}, selection: { read: () => undefined } }),
}))

vi.mock("@/features/session/ui/controls/agent-harness-selector", () => ({
  AgentHarnessSelector: (props: { directory?: string }) => (
    <div data-testid="harness-selector" data-directory={props.directory ?? ""} />
  ),
}))

const { PresetConfigurationEditor } = await import("./preset-configuration-editor")

afterEach(cleanup)

function mount() {
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PresetConfigurationEditor
        editorKey="new"
        slot="primary"
        configuration={EMPTY_CONFIGURATION}
        onChange={() => {}}
        disabled={false}
        placement="local"
      />
    </QueryClientProvider>
  ))
}

describe("preset configuration editor", () => {
  test("with no project registered it says where the catalog comes from instead of showing an empty picker", async () => {
    state.projects = []
    mount()

    await waitFor(() =>
      expect(screen.getByTestId("preset-configuration-catalog-primary").textContent).toContain("Add a project first"),
    )
    expect(screen.queryByTestId("harness-selector")).toBeNull()
  })

  test("with a project it reads the catalog from that project's worktree", async () => {
    state.projects = [{ id: "prj_1", name: "Importer", worktree: "/repo/importer" }]
    mount()

    await waitFor(() =>
      expect(screen.getByTestId("harness-selector").getAttribute("data-directory")).toBe("/repo/importer"),
    )
    expect(screen.queryByTestId("preset-configuration-catalog-primary")).toBeNull()
  })
})
