import { createSignal } from "solid-js"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"
import type { OnboardingWizard } from "@/features/onboarding/wizard"

type WizardProps = Parameters<typeof OnboardingWizard>[0]

const health = vi.hoisted(() => ({ localExecution: true as boolean | undefined }))
const posture = vi.hoisted(() => ({ issuesSessions: false as boolean | undefined }))
const createIntent = vi.hoisted(() => ({ pending: false, bump: () => {}, answer: () => {} }))
const wizard = vi.hoisted(() => ({ props: undefined as WizardProps | undefined }))
const funnel = vi.hoisted(() => ({ events: [] as string[] }))
const cloud = vi.hoisted(() => ({
  calls: [] as unknown[],
  navigated: [] as string[],
  inventoryRefreshes: 0,
}))

vi.mock("@/app/connection/server", () => ({
  useServer: () => ({ url: "http://server.test" }),
}))

vi.mock("@/app/connection/server-health", () => ({
  serverHealthQueryOptions: () => ({
    queryKey: ["server", "health", "test"],
    queryFn: async () => ({ healthy: true, localExecution: health.localExecution }),
  }),
}))

vi.mock("@/app/connection/deployment-posture", () => ({
  useDeploymentPosture: () => ({ issuesSessions: () => posture.issuesSessions }),
}))

vi.mock("@/app/providers/layout", () => ({
  useLayout: () => ({
    projects: {
      createPending: () => createIntent.pending,
      answerCreate: () => createIntent.answer(),
      registerCreateSurface: () => () => {},
    },
  }),
}))

vi.mock("@/app/integrations/onboarding-funnel", () => ({
  useOnboardingFunnel: () => ({ emit: (event: { name: string }) => funnel.events.push(event.name) }),
}))

vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({ projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }) }),
}))

vi.mock("@/features/workspaces/data/query/project-ensure", () => ({
  refreshProjectInventory: async () => {
    cloud.inventoryRefreshes += 1
    return []
  },
}))

vi.mock("@/features/workspaces/data/workspace-create-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/workspaces/data/workspace-create-api")>()),
  createCloudWorkspace: async (input: unknown) => {
    cloud.calls.push(input)
    return { workspaceId: "ws_1", directory: "ws_1" }
  },
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => (path: string) => cloud.navigated.push(path),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))

vi.mock("@/features/session/ui/components/session-pick-project-folder", () => ({
  pickProjectFolderWith: () => async () => "/home/me/demo",
}))

// The wizard is its own surface with its own tests; this host is about what
// it is handed and what it does with the answers.
vi.mock("@/features/onboarding/wizard", () => ({
  OnboardingWizard: (props: WizardProps) => {
    wizard.props = props
    return (
      <div data-testid="onboarding-wizard-fake">
        <button type="button" ref={(element) => props.leadField?.(element)}>
          lead
        </button>
        {props.footer}
      </div>
    )
  },
}))

const [pending, setPending] = createSignal(false)
createIntent.bump = () => setPending(true)
createIntent.answer = () => setPending(false)
Object.defineProperty(createIntent, "pending", { get: () => pending() })

const { FirstProjectCanvas } = await import("./first-project-canvas")

const renderCanvas = (props: Parameters<typeof FirstProjectCanvas>[0] = {}) =>
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FirstProjectCanvas {...props} />
    </QueryClientProvider>
  ))

afterEach(() => {
  health.localExecution = true
  posture.issuesSessions = false
  wizard.props = undefined
  funnel.events = []
  cloud.calls = []
  cloud.navigated = []
  cloud.inventoryRefreshes = 0
  cleanup()
})

describe("FirstProjectCanvas", () => {
  test("hosts the wizard as the whole screen, on the server's own account of local execution", async () => {
    renderCanvas()
    expect(screen.getByTestId("first-project-canvas")).toBeTruthy()
    await waitFor(() => expect(wizard.props?.localExecution).toBe(true))
    expect(wizard.props?.baseUrl).toBe("http://server.test")
    expect(screen.queryByText("No projects yet. Create one to get started.")).toBeNull()
  })

  test("a server without its own filesystem hands the wizard the hosted product", async () => {
    health.localExecution = false
    renderCanvas()
    await waitFor(() => expect(wizard.props?.localExecution).toBe(false))
  })

  // `localExecution` is the server's own statement and wins wherever it is
  // made. Where it is absent, the posture declaration is what is left: a
  // central that issues sessions is not running projects off this machine's
  // filesystem.
  test("a server that states nothing about its filesystem falls to the posture declaration", async () => {
    health.localExecution = undefined
    posture.issuesSessions = true
    renderCanvas()
    await waitFor(() => expect(wizard.props?.localExecution).toBe(false))
    cleanup()

    health.localExecution = undefined
    posture.issuesSessions = false
    renderCanvas()
    await waitFor(() => expect(wizard.props?.localExecution).toBe(true))
  })

  test("funnel events pass through the app's funnel", () => {
    renderCanvas()
    wizard.props?.emit({ name: "setup_form_shown" })
    expect(funnel.events).toEqual(["setup_form_shown"])
  })

  test("a created project reaches onProjectCreated as the record the shell opens", () => {
    const opened: NewSessionProjectSelection[] = []
    renderCanvas({ onProjectCreated: (project) => opened.push(project) })
    wizard.props?.onProjectCreated({ id: "prj_1", worktree: "/home/me/demo" })
    expect(opened).toEqual([{ id: "prj_1", worktree: "/home/me/demo" }])
  })

  test("a hosted finish creates the cloud workspace from the draft, re-lists projects, and opens it", async () => {
    health.localExecution = false
    renderCanvas()
    await waitFor(() => expect(wizard.props).toBeTruthy())
    await wizard.props!.createCloudWorkspace({
      projectName: "widgets",
      source: { kind: "repository", repoUrl: "https://github.com/acme/widgets" },
    })
    expect(cloud.calls).toEqual([
      { baseUrl: "http://server.test", projectName: "widgets", repoUrl: "https://github.com/acme/widgets" },
    ])
    expect(cloud.inventoryRefreshes).toBe(1)
    expect(cloud.navigated).toEqual(["/w/ws_1/session"])
  })

  test("answers the shell's create-project intent by focusing the wizard's leading control", async () => {
    renderCanvas()
    const lead = screen.getByRole("button", { name: "lead" })
    lead.blur()
    createIntent.bump()
    await waitFor(() => expect(document.activeElement).toBe(lead))
    expect(pending()).toBe(false)
  })

  test("Diagnostics appears only when the shell supplies it", () => {
    renderCanvas()
    expect(screen.queryByTestId("empty-diagnostics-trigger")).toBeNull()
    cleanup()

    let diagnostics = 0
    renderCanvas({ onDiagnostics: () => (diagnostics += 1) })
    fireEvent.click(screen.getByTestId("empty-diagnostics-trigger"))
    expect(diagnostics).toBe(1)
  })
})
