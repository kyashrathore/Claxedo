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
  machineRunnable: false,
  connected: {} as Record<string, string[]>,
}))

vi.mock("@/features/onboarding/app-ports", () => ({
  ProjectCreateForm: (props: { onSubmit?: (source: ProjectSource) => void; submitLabel?: string; leadField?: (element: HTMLElement) => void }) => (
    <button type="button" ref={(element) => props.leadField?.(element)} onClick={() => props.onSubmit?.(fixture.source)}>
      {props.submitLabel}
    </button>
  ),
  createProject: async (input: { baseUrl?: string; source: ProjectSource }) => {
    fixture.created.push(input)
    if (fixture.createFailure) throw fixture.createFailure
    return { id: "prj_1", name: "widgets", env: {}, checkoutDirectory: fixture.checkoutDirectory, repoUrl: null, created_at: 1, updated_at: 1 }
  },
  projectRequestMessage: (cause: unknown) => {
    const text = cause instanceof Error ? cause.message : String(cause)
    return /"message":"([^"]+)"/.exec(text)?.[1] ?? text
  },
  MachineAccountsProvider: (props: { children?: unknown }) => props.children,
  useMachineAccounts: () => ({ runnable: () => fixture.machineRunnable }),
  AgentHarnessAccounts: (props: { harness: { id: string } }) => <div data-harness-row={props.harness.id} />,
  HarnessProvidersSection: (props: { harness: string }) => <div data-providers-section={props.harness} />,
  useProviders: (harness: string) => ({
    all: () => new Map(),
    connected: () => (fixture.connected[harness] ?? []).map((id) => ({ id, name: id })),
    loading: () => false,
    error: () => undefined,
    refresh: async () => undefined,
  }),
  putProviderAuthEntry: async () => undefined,
  workspaceSandboxDriversUrl: () => "http://server.test/api/workspace/drivers",
  workspaceSandboxDriverAuthUrl: () => "http://server.test/api/workspace/drivers/x/auth",
  SandboxDriverLogo: () => <span />,
}))

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
  fixture.machineRunnable = false
  fixture.connected = {}
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
    expect(document.querySelector('[data-providers-section="pi"]')).toBeTruthy()
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true)
    expect(reason()).toBe("Connect a login above, or skip and connect at your first message.")
    expect(fixture.created).toEqual([])

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
})

describe("OnboardingWizard on the hosted plane", () => {
  test("needs a stored Pi key, offers the deployment's sandbox, and creates the workspace at Finish", async () => {
    fixture.source = { kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/widgets" } }
    const { events, cloud, opened } = mount({ localExecution: false })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(step()).toBe("ai")
    expect(document.querySelector('[data-slot="onboarding-ai-hosted"]')).toBeTruthy()
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
