/**
 * The create-cloud-project dialog, exercised as a hosted user meets it.
 *
 * Two things made "New Project" unusable on app.claxedo.com, and neither is
 * visible in a source-text assertion:
 *
 *   1. `GET /api/workspace/drivers` exists ONLY on the local control plane, so
 *      the hosted request 404s. The dialog gated submit on `provider()`, which
 *      the failed request left empty forever — "Clone & Open" was permanently
 *      disabled and no project could be created at all.
 *   2. The repository section rendered only when repositories already existed,
 *      and there was no way to connect GitHub from inside the dialog. A user
 *      with no connection had no move.
 */
import { onMount } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogCreateCloudProject } from "./create-cloud-project"
import { configureWorkspaceCreateAuthority } from "@/platform/runtime/agent/workspace-create-authority"
import { createCloudWorkspace } from "@/features/workspaces/data/workspace-create-api"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
const authFetchMock = vi.hoisted(() => vi.fn())
const connectIntegrationMock = vi.hoisted(() => vi.fn())

vi.mock("@/platform/api/api", () => ({
  api: apiMocks,
  authFetch: authFetchMock,
  getDefaultBaseUrl: () => "http://test.local",
  normalizeUrl: (value: string | undefined) => value?.replace(/\/+$/, ""),
}))

vi.mock("@/features/workspaces/app-ports", () => ({
  useClaxedoEvents: () => ({ on: () => () => {} }),
  DialogConnectIntegration: (props: Record<string, unknown>) => {
    connectIntegrationMock(props)
    return <div data-testid="connect-integration-dialog" />
  },
}))

afterEach(() => {
  cleanup()
  // Kobalte portals mount OUTSIDE the render container, and the provider's
  // close path disposes on a 100ms timer, so `cleanup()` alone leaves the
  // previous test's dialog in `document.body` — every query would then match
  // two dialogs and the failure reads as a component bug rather than leakage.
  for (const node of document.querySelectorAll("[data-dialog-layer]")) node.remove()
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  authFetchMock.mockReset()
  connectIntegrationMock.mockReset()
})

const GITHUB_INTEGRATION = {
  id: "github",
  name: "GitHub",
  methods: ["oauth"],
  capabilities: ["code-host"],
}

const REPOSITORY = {
  id: "1",
  name: "app",
  fullName: "acme/app",
  private: true,
  permissions: { read: true, write: true },
}

/** Scripts the two `/api/claxedo/integrations` reads the dialog performs. */
function integrationsResponses(input: {
  connections?: unknown[]
  integrations?: unknown[]
  repositories?: unknown[]
}) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/repositories")) return Response.json({ repositories: input.repositories ?? [] })
    return Response.json({
      connections: input.connections ?? [],
      integrations: input.integrations ?? [],
    })
  })
}

/**
 * Mounted through `dialog.show`, not rendered bare: the `Dialog` shell needs
 * the Kobalte context the provider's `mount` wraps around it, and going through
 * the real stack is also what lets the "connect dialog layers ON TOP" assertion
 * mean anything.
 */
function Harness() {
  const dialog = useDialog()
  onMount(() => void dialog.show(() => <DialogCreateCloudProject onSelect={() => {}} />))
  return null
}

// Production binds the create authority to the transport-aware create
// function (workspace-connection-authority-sync.tsx); here that function runs
// against the mocked API.
beforeEach(() => configureWorkspaceCreateAuthority((input) => createCloudWorkspace(input)))
afterEach(() => configureWorkspaceCreateAuthority(undefined))

function renderDialog() {
  return render(() => (
    <DialogProvider>
      <Harness />
    </DialogProvider>
  ))
}

const submitButton = () => screen.getByRole("button", { name: "Clone & Open" }) as HTMLButtonElement

describe("create cloud project onboarding", () => {
  test("sends the entered name and the environment rows with the create request", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    apiMocks.post.mockResolvedValue({ workspaceId: "ws_1", directory: "/w/1" })
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    fireEvent.input(screen.getByLabelText("Project name"), { target: { value: "Demo App" } })
    fireEvent.input(screen.getByPlaceholderText("https://github.com/username/repo"), {
      target: { value: "https://github.com/acme/app.git" },
    })
    fireEvent.click(screen.getByText("+ Add variable"))
    const names = screen.getAllByLabelText("Variable name")
    const values = screen.getAllByLabelText("Variable value")
    fireEvent.input(names[0]!, { target: { value: "DATABASE_URL" } })
    fireEvent.input(values[0]!, { target: { value: "postgres://localhost/demo" } })
    fireEvent.input(names[1]!, { target: { value: "NODE_ENV" } })
    fireEvent.input(values[1]!, { target: { value: "development" } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    fireEvent.click(submitButton())

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]![1]).toMatchObject({
      projectName: "Demo App",
      repoUrl: "https://github.com/acme/app.git",
      env: { DATABASE_URL: "postgres://localhost/demo", NODE_ENV: "development" },
    })
  })

  test("defaults the name to the repository and omits an empty environment", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    apiMocks.post.mockResolvedValue({ workspaceId: "ws_1", directory: "/w/1" })
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    fireEvent.input(screen.getByPlaceholderText("https://github.com/username/repo"), {
      target: { value: "https://github.com/acme/app.git" },
    })
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    fireEvent.click(submitButton())

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    const body = apiMocks.post.mock.calls[0]![1] as Record<string, unknown>
    expect(body).toMatchObject({ projectName: "app" })
    expect(body).not.toHaveProperty("env")
  })

  test("holds submit while a variable name is invalid, a name is missing, or a name repeats", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    fireEvent.input(screen.getByPlaceholderText("https://github.com/username/repo"), {
      target: { value: "https://github.com/acme/app.git" },
    })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    fireEvent.input(screen.getAllByLabelText("Variable name")[0]!, { target: { value: "1BAD" } })
    await waitFor(() => expect(submitButton().disabled).toBe(true))
    expect(screen.getByText('"1BAD" is not a valid variable name')).toBeTruthy()

    fireEvent.input(screen.getAllByLabelText("Variable name")[0]!, { target: { value: "" } })
    fireEvent.input(screen.getAllByLabelText("Variable value")[0]!, { target: { value: "orphan" } })
    await waitFor(() => expect(screen.getByText("Each value needs a variable name")).toBeTruthy())

    fireEvent.input(screen.getAllByLabelText("Variable name")[0]!, { target: { value: "KEY" } })
    fireEvent.click(screen.getByText("+ Add variable"))
    fireEvent.input(screen.getAllByLabelText("Variable name")[1]!, { target: { value: "KEY" } })
    await waitFor(() => expect(screen.getByText('"KEY" is listed twice')).toBeTruthy())
    expect(submitButton().disabled).toBe(true)
  })
})

describe("create cloud project dialog on a hosted control plane", () => {
  test("submit is reachable when the drivers endpoint is absent", async () => {
    // THE bug: a 404 from `/api/workspace/drivers` used to disable the submit
    // button permanently, because the dialog demanded a provider the hosted
    // plane never offers.
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({
      connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      repositories: [REPOSITORY],
    })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connected GitHub repository")).toBeTruthy())
    // Nothing chosen yet, so still disabled — for the RIGHT reason.
    expect(submitButton().disabled).toBe(true)

    const select = screen.getByRole("combobox") as HTMLSelectElement
    fireEvent.input(select, { target: { value: "1" } })

    await waitFor(() => expect(submitButton().disabled).toBe(false))
  })

  test("the sandbox provider picker is hidden when no driver choice exists", async () => {
    // An empty `<select>` labelled "Sandbox Provider" is a control the user
    // cannot satisfy; the hosted plane composes one driver from env.
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    expect(screen.queryByText("Sandbox Provider")).toBeNull()
  })

  test("create omits the driver field entirely when the server picks it", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    apiMocks.post.mockResolvedValue({ workspaceId: "ws_1", directory: "/w/1" })
    integrationsResponses({
      connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      repositories: [REPOSITORY],
    })

    renderDialog()
    await waitFor(() => expect(screen.getByText("Connected GitHub repository")).toBeTruthy())
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "1" } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    fireEvent.click(submitButton())

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    const body = apiMocks.post.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(body)).not.toContain("driver")
    expect(body).toMatchObject({ connectionId: "connection-1", repo: { fullName: "acme/app" } })
  })
})

describe("create cloud project dialog with no GitHub connection", () => {
  test("offers Connect GitHub instead of dead-ending", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    // No repositories to pick, so the picker stays hidden — the connect action
    // is what replaces it.
    expect(screen.queryByText("Connected GitHub repository")).toBeNull()
  })

  test("Connect GitHub opens the shared connect dialog wired to the integrations route", async () => {
    // Reuses the SAME dialog Settings uses rather than forking a second connect
    // flow, so device-code display and attempt polling behave identically.
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()
    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())

    fireEvent.click(screen.getByText("Connect GitHub"))

    await waitFor(() => expect(connectIntegrationMock).toHaveBeenCalled())
    const props = connectIntegrationMock.mock.calls[0]![0] as Record<string, unknown>
    expect(props.integration).toMatchObject({ id: "github", name: "GitHub" })
    expect(typeof props.request).toBe("function")
    expect(typeof props.onConnected).toBe("function")
  })

  test("the create dialog survives the connect dialog so typed input is not lost", async () => {
    // `dialog.show` disposes the whole stack; using it here would unmount this
    // dialog mid-flow. `push` layers instead.
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()
    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())

    fireEvent.click(screen.getByText("Connect GitHub"))

    await waitFor(() => expect(screen.getByTestId("connect-integration-dialog")).toBeTruthy())
    expect(screen.getByText("Git Repository URL")).toBeTruthy()
  })

  test("connecting refreshes the repository list in place", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()
    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    fireEvent.click(screen.getByText("Connect GitHub"))
    await waitFor(() => expect(connectIntegrationMock).toHaveBeenCalled())

    // The connect completes: the route now reports a live connection.
    integrationsResponses({
      connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      integrations: [GITHUB_INTEGRATION],
      repositories: [REPOSITORY],
    })
    const props = connectIntegrationMock.mock.calls[0]![0] as { onConnected: () => Promise<void> }
    await props.onConnected()

    await waitFor(() => expect(screen.getByText("Connected GitHub repository")).toBeTruthy())
    expect(screen.getByText("acme/app")).toBeTruthy()
    // The offer retires once it has been taken.
    expect(screen.queryByText("Connect GitHub")).toBeNull()
  })

  test("the public-URL escape hatch still enables submit with no connection at all", async () => {
    apiMocks.get.mockRejectedValue(new Error("Request failed: 404"))
    integrationsResponses({ integrations: [GITHUB_INTEGRATION] })

    renderDialog()
    await waitFor(() => expect(screen.getByText("Connect GitHub")).toBeTruthy())
    expect(submitButton().disabled).toBe(true)

    fireEvent.click(screen.getByText("Try the example public repository"))

    await waitFor(() => expect(submitButton().disabled).toBe(false))
  })
})

describe("create cloud project dialog on a local control plane", () => {
  test("still requires an explicit provider when drivers are offered", async () => {
    // The local gate is not loosened: where the user IS given a choice, an
    // unchosen provider still blocks submit.
    apiMocks.get.mockResolvedValue({
      default_driver: "",
      drivers: [{ id: "daytona", label: "Daytona", configured: true, default: true }],
    })
    integrationsResponses({
      connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      repositories: [REPOSITORY],
    })

    renderDialog()

    await waitFor(() => expect(screen.getByText("Sandbox Provider")).toBeTruthy())
    // Both selects exist only once the repository load settles too; indexing
    // before that would grab the provider select and assert nothing.
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(2))
    fireEvent.input(screen.getAllByRole("combobox")[1]!, { target: { value: "1" } })

    // A repository is chosen, so only the empty provider is holding submit.
    await waitFor(() => expect(submitButton().disabled).toBe(true))
  })

  test("sends the chosen driver when the picker offered one", async () => {
    apiMocks.get.mockResolvedValue({
      default_driver: "daytona",
      drivers: [{ id: "daytona", label: "Daytona", configured: true, default: true }],
    })
    apiMocks.post.mockResolvedValue({ workspaceId: "ws_1", directory: "/w/1" })
    integrationsResponses({
      connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      repositories: [REPOSITORY],
    })

    renderDialog()
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(2))
    fireEvent.input(screen.getAllByRole("combobox")[1]!, { target: { value: "1" } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    fireEvent.click(submitButton())

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]![1]).toMatchObject({ driver: "daytona" })
  })
})
