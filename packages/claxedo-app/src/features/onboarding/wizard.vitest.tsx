import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ProjectSource } from "./draft"
import type { OnboardingFunnelEvent } from "./funnel"

const fixture = vi.hoisted(() => ({
  source: { kind: "directory", folder: "/home/me/widgets" } as ProjectSource,
  created: [] as Array<{ baseUrl?: string; source: ProjectSource }>,
  checkoutDirectory: "/home/me/widgets" as string | null,
  createFailure: undefined as Error | undefined,
  existing: undefined as { id: string; checkoutDirectory: string } | undefined,
  lookups: [] as string[],
  machineRunnable: false,
  connected: {} as Record<string, string[]>,
  formMounts: 0,
}))

vi.mock("@/features/onboarding/app-ports", async () => {
  const projectApi = await vi.importActual<typeof import("@/features/workspaces/data/project-api")>("@/features/workspaces/data/project-api")
  return {
  // A form with a state of its own, so the test can tell a kept form from a rebuilt one.
  ProjectCreateForm: (props: { onSubmit?: (source: ProjectSource) => void; submitLabel?: string; leadField?: (element: HTMLElement) => void }) => {
    fixture.formMounts += 1
    return (
      <>
        <input aria-label="Repository URL" />
        <button type="button" ref={(element) => props.leadField?.(element)} onClick={() => props.onSubmit?.(fixture.source)}>
          {props.submitLabel}
        </button>
      </>
    )
  },
  createProject: async (input: { baseUrl?: string; source: ProjectSource }) => {
    fixture.created.push(input)
    if (fixture.createFailure) throw fixture.createFailure
    return { id: "prj_1", name: "widgets", env: {}, checkoutDirectory: fixture.checkoutDirectory, repoUrl: null, created_at: 1, updated_at: 1 }
  },
  projectRequestMessage: projectApi.projectRequestMessage,
  projectRequestCode: projectApi.projectRequestCode,
  projectByCheckout: async (input: { worktree: string }) => {
    fixture.lookups.push(input.worktree)
    const found = fixture.existing
    return found ? { id: found.id, name: "Claxedo", env: {}, checkoutDirectory: found.checkoutDirectory, repoUrl: null, created_at: 1, updated_at: 1 } : undefined
  },
  MachineAccountsProvider: (props: { children?: unknown }) => props.children,
  useMachineAccounts: () => ({ opened: () => true, runnable: () => fixture.machineRunnable }),
  AgentHarnessAccounts: (props: { harness: { id: string } }) => <div data-harness-row={props.harness.id} />,
  HarnessProvidersSection: (props: { harness: string }) => <div data-providers-section={props.harness} />,
  useProviders: (harness: string) => ({
    all: () => new Map(),
    connected: () => (fixture.connected[harness] ?? []).map((id) => ({ id, name: id })),
    loading: () => false,
    error: () => undefined,
    refresh: async () => undefined,
  }),
  workspaceSandboxDriversUrl: () => "http://server.test/api/workspace/drivers",
  workspaceSandboxDriverAuthUrl: () => "http://server.test/api/workspace/drivers/x/auth",
  SandboxDriverLogo: () => <span />,
  }
})

vi.mock("@/platform/api/api", () => ({ authFetch: async () => new Response("{}") }))

const { OnboardingWizard } = await import("./wizard")

function mount(input: { localExecution: boolean }) {
  const events: OnboardingFunnelEvent[] = []
  const opened: Array<{ id: string; worktree: string }> = []
  const cloud: Array<{ projectName: string; source: ProjectSource }> = []
  const [localExecution, setLocalExecution] = createSignal(input.localExecution)
  render(() => (
    <OnboardingWizard
      baseUrl="http://server.test"
      localExecution={localExecution()}
      emit={(event) => events.push(event)}
      onProjectCreated={(project) => opened.push(project)}
      createCloudWorkspace={async (draft) => {
        cloud.push(draft)
      }}
    />
  ))
  return { events, opened, cloud, setLocalExecution }
}

const step = () => screen.getByTestId("onboarding-wizard").getAttribute("data-step")
const reason = () => screen.getByTestId("onboarding-wizard").querySelector('[data-slot="onboarding-reason"]')?.textContent

afterEach(() => {
  fixture.source = { kind: "directory", folder: "/home/me/widgets" }
  fixture.created = []
  fixture.checkoutDirectory = "/home/me/widgets"
  fixture.createFailure = undefined
  fixture.existing = undefined
  fixture.lookups = []
  fixture.machineRunnable = false
  fixture.connected = {}
  fixture.formMounts = 0
  cleanup()
})

describe("OnboardingWizard on a desktop", () => {
  test("walks project → AI → where it runs and creates the project only at Finish", async () => {
    const { events, opened } = mount({ localExecution: true })
    expect(events).toEqual([{ name: "setup_form_shown" }])
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Start with a project")
    expect(step()).toBe("project")

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(step()).toBe("ai")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Connect an AI")
    expect(screen.getByText("widgets")).toBeTruthy()
    expect(document.querySelector('[data-harness-row="claude"]')).toBeTruthy()
    expect(document.querySelector('[data-harness-choice="pi"]')).toBeTruthy()
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true)
    expect(reason()).toBe("Connect a login above, or skip and connect at your first message.")
    expect(fixture.created).toEqual([])
    // The rows scroll inside the card; the reason and the buttons are the
    // card's footer, outside the scroll region, so they never leave the screen.
    const body = document.querySelector('[data-slot="onboarding-card-body"]')!
    expect(body.classList.contains("scroll-view")).toBe(true)
    expect(body.querySelector('.scroll-view__viewport [data-harness-row="claude"]')).toBeTruthy()
    const footer = body.nextElementSibling!
    expect(footer.getAttribute("data-slot")).toBe("onboarding-card-footer")
    expect(footer.contains(screen.getByRole("button", { name: "Next" }))).toBe(true)
    expect(footer.contains(document.querySelector('[data-slot="onboarding-reason"]'))).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(step()).toBe("execution")
    expect(screen.getByRole("radio", { name: /Just this machine/ }).getAttribute("aria-checked")).toBe("true")
    await waitFor(() => expect(screen.getByRole("button", { name: "Open project" }).disabled).toBe(false))

    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    await waitFor(() => expect(opened).toEqual([{ id: "prj_1", worktree: "/home/me/widgets" }]))
    expect(fixture.created).toEqual([{ baseUrl: "http://server.test", source: { kind: "directory", folder: "/home/me/widgets" } }])
    expect(events.map((event) => (event.name === "step_done" ? `done:${event.step}` : event.name))).toEqual([
      "setup_form_shown",
      "done:project",
      "done:ai",
      "done:execution",
    ])
  })

  test("a runnable login enables Next and hides Skip", () => {
    fixture.machineRunnable = true
    mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(false)
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull()
    expect(reason()).toBe("")
  })

  test("a refused create stays on the screen with the server's sentence", async () => {
    fixture.createFailure = new Error('{"error":{"code":"project_not_git","message":"Only git repositories can be projects; that folder is not one"}}')
    const { opened, events } = mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Only git repositories can be projects; that folder is not one"))
    expect(opened).toEqual([])
    expect(events.some((event) => event.name === "step_done" && event.step === "execution")).toBe(false)
  })

  test("a server sentence with quotes in it is shown whole", async () => {
    fixture.createFailure = new Error(JSON.stringify({ error: { code: "project_name_taken", message: 'A project named "widgets" already exists' } }))
    mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe('A project named "widgets" already exists'))
  })

  test("a folder the server already holds as a project opens that project", async () => {
    fixture.createFailure = new Error(JSON.stringify({ error: { code: "project_directory_taken", message: 'That folder is already the project "Claxedo"' } }))
    fixture.existing = { id: "prj_existing", checkoutDirectory: "/home/me/widgets" }
    const { opened } = mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    await waitFor(() => expect(opened).toEqual([{ id: "prj_existing", worktree: "/home/me/widgets" }]))
    expect(fixture.lookups).toEqual(["/home/me/widgets"])
    expect(screen.queryByRole("alert")).toBeNull()
  })

  test("a checkout the app cannot open is refused rather than handed on", async () => {
    fixture.checkoutDirectory = "/workspace"
    const { opened } = mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("/workspace"))
    expect(opened).toEqual([])
  })

  test("Back returns to the previous step, down to the form", () => {
    mount({ localExecution: true })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(step()).toBe("execution")
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(step()).toBe("ai")
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(step()).toBe("project")
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy()
  })

  test("a step is shown again as it was left: each mounts once and is hidden, not rebuilt, while another is open", () => {
    mount({ localExecution: true })
    const panel = (id: string) => document.querySelector<HTMLElement>(`[data-step-panel="${id}"]`)
    const url = screen.getByLabelText<HTMLInputElement>("Repository URL")
    fireEvent.input(url, { target: { value: "https://github.com/acme/widgets" } })
    expect(fixture.formMounts).toBe(1)
    expect(panel("ai")).toBeNull()
    expect(panel("execution")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(panel("project")!.hidden).toBe(true)
    expect(panel("ai")!.hidden).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Pi" }))
    expect(document.querySelector('[data-providers-section="pi"]')).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(panel("execution")!.hidden).toBe(false)
    expect(panel("ai")!.hidden).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: /A cloud sandbox/ }))
    expect(screen.getByRole("radio", { name: /A cloud sandbox/ }).getAttribute("aria-checked")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(step()).toBe("ai")
    expect(document.querySelector('[data-providers-section="pi"]')).toBeTruthy()
    expect(panel("execution")!.hidden).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(step()).toBe("project")
    expect(panel("project")!.hidden).toBe(false)
    expect(fixture.formMounts).toBe(1)
    expect(screen.getByLabelText<HTMLInputElement>("Repository URL").value).toBe("https://github.com/acme/widgets")

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(screen.getByRole("radio", { name: /A cloud sandbox/ }).getAttribute("aria-checked")).toBe("true")
  })
})

describe("OnboardingWizard on the hosted plane", () => {
  test("needs a stored Pi key, offers the deployment's sandbox, and creates the workspace at Finish", async () => {
    fixture.source = { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/widgets" } }
    const { events, cloud, opened } = mount({ localExecution: false })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(step()).toBe("ai")
    // The same Pi provider rows Settings → Models draws, and nothing of a machine.
    expect(document.querySelector('[data-providers-section="pi"]')).toBeTruthy()
    expect(document.querySelector('[data-providers-section="opencode"]')).toBeNull()
    expect(document.querySelector("[data-harness-row]")).toBeNull()
    expect(screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent).toContain("Cloud sandboxes here run Pi")
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true)
    expect(reason()).toBe("Save a key for one provider to continue.")
    cleanup()

    fixture.connected = { pi: ["anthropic"] }
    const again = mount({ localExecution: false })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(step()).toBe("execution")
    expect(screen.queryByRole("radio", { name: /Just this machine/ })).toBeNull()
    expect(screen.getByRole("radio", { name: /A cloud sandbox/ }).getAttribute("aria-checked")).toBe("true")
    expect(document.querySelector('[data-slot="onboarding-cloud-hosted"]')).toBeTruthy()

    fireEvent.click(screen.getByRole("radio", { name: /Another machine/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Create workspace" }).disabled).toBe(true))
    expect(reason()).toBe("Pick the cloud sandbox to finish; a connected machine cannot take this repository yet.")

    fireEvent.click(screen.getByRole("radio", { name: /A cloud sandbox/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Create workspace" }).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }))
    await waitFor(() => expect(again.cloud).toEqual([{ projectName: "widgets", source: fixture.source }]))
    expect(again.opened).toEqual([])
    expect(fixture.created).toEqual([])
    expect(again.events.at(-1)).toEqual({ name: "step_done", step: "execution" })
    expect(events.length).toBeGreaterThan(0)
    expect(cloud).toEqual([])
    expect(opened).toEqual([])
  })

  test("a server that declares itself hosted after the wizard mounted still preselects the cloud row", async () => {
    fixture.connected = { pi: ["anthropic"] }
    const { setLocalExecution } = mount({ localExecution: true })
    setLocalExecution(false)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.queryByRole("radio", { name: /Just this machine/ })).toBeNull()
    expect(screen.getByRole("radio", { name: /A cloud sandbox/ }).getAttribute("aria-checked")).toBe("true")
    await waitFor(() => expect(screen.getByRole("button", { name: "Create workspace" }).disabled).toBe(false))
  })
})
