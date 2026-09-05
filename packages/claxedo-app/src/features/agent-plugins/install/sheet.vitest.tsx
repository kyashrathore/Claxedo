// Install-sheet behavior against a fake `AgentPluginApi` and connection port:
// the bodies the two rails receive (project target, harness ids), the gating of
// the Enterprise choice, and the exact order activation → organizationDefault →
// connections.open.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate } from "@/features/agent-plugins/api"
import type { AgentPluginConnectionPort } from "@/features/agent-plugins/connections"

const closeDialog = vi.fn()

vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: closeDialog }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: JSX.Element; children?: JSX.Element }) => (
    <div>
      <div>{props.title}</div>
      {props.children}
    </div>
  ),
}))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { disabled?: boolean; onClick?: () => void; children?: JSX.Element }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onClick?.()}>
      {props.children}
    </button>
  ),
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

const { InstallAgentPluginSheet } = await import("./sheet")
const { showToast } = await import("@opencode-ai/ui/toast")

const HARNESSES: AgentPluginHarness[] = ["opencode", "claude", "codex", "cursor"]

const ready = {
  explicit: null,
  projectOverride: null,
  userDefault: null,
  organizationDefault: false,
  claxedoDefault: false,
  effective: { status: "ready" as const, effective: false, winner: "none" },
}

function candidate(input: { oauth?: boolean; unavailable?: AgentPluginHarness } = {}): PluginCandidate {
  const harnesses = Object.fromEntries(HARNESSES.map((harnessId) => [
    harnessId,
    harnessId === input.unavailable
      ? { ...ready, effective: { status: "artifact-unavailable" as const, effective: false, winner: "none" } }
      : ready,
  ])) as PluginCandidate["harnesses"]
  return {
    pluginInstanceId: "[\"claxedo\",\"composio\"]",
    sourceId: "claxedo",
    sourceKind: "claxedo",
    source: { id: "claxedo", kind: "claxedo", label: "Claxedo" },
    icon: { kind: "monogram", text: "C" },
    skills: [],
    sourceRevision: "main",
    relativePath: "composio",
    candidateDigest: "sha256:candidate",
    sourceAvailable: true,
    retainedDigest: "sha256:retained",
    updateAvailable: false,
    manifest: { name: "composio", version: "1.0.0" },
    componentDiagnostics: [],
    mcpServers: input.oauth
      ? [{ name: "composio", type: "streamable-http", authentication: { state: "oauth", integrationId: "mcp-composio" } }]
      : [{ name: "clangd", type: "stdio", authentication: { state: "local" } }],
    harnesses,
  }
}

type ActivationBody = Parameters<AgentPluginApi["activation"]>[0]
type OrganizationBody = Parameters<AgentPluginApi["organizationDefault"]>[0]

function harness(input: {
  mode?: "signed" | "unsigned"
  plugin?: PluginCandidate
  organizationManager?: boolean
  reconciliation?: { state: string; message?: string }
  withConnections?: boolean
} = {}) {
  const order: string[] = []
  const activation = vi.fn(async (body: ActivationBody) => {
    order.push("activation")
    return { revision: 8, reconciliation: input.reconciliation ?? { state: "applied" } }
  })
  const organizationDefault = vi.fn(async (body: OrganizationBody) => {
    order.push("organizationDefault")
    return { revision: 9, reconciliation: { state: "applied" } }
  })
  const api = {
    catalog: vi.fn<AgentPluginApi["catalog"]>(),
    skill: vi.fn<AgentPluginApi["skill"]>(),
    update: vi.fn<AgentPluginApi["update"]>(),
    activation,
    organizationDefault,
  } satisfies AgentPluginApi
  const open = vi.fn<AgentPluginConnectionPort["open"]>(() => order.push("connections.open"))
  const connections: AgentPluginConnectionPort = {
    load: async () => ({ connections: [] }),
    open,
    disconnect: async () => {},
  }
  const onDone = vi.fn()
  render(() => (
    <InstallAgentPluginSheet
      plugin={input.plugin ?? candidate()}
      mode={input.mode ?? "signed"}
      catalog={{
        revision: 4,
        projects: [{ id: "project-1", label: "Project One" }, { id: "project-2", label: "Project Two" }],
        supportedHarnesses: HARNESSES,
        canManageOrganizationDefaults: input.organizationManager === true,
        canManageOrganizationConnections: input.organizationManager === true,
        organizationName: "Claxedo Acceptance Staging",
      }}
      api={api}
      {...(input.withConnections === false ? {} : { connections })}
      onDone={onDone}
    />
  ))
  return { activation, organizationDefault, open, onDone, order }
}

const click = (name: string | RegExp, role: "button" | "checkbox" | "radio" = "button") =>
  fireEvent.click(screen.getByRole(role, { name }))

afterEach(() => {
  cleanup()
  closeDialog.mockClear()
  vi.mocked(showToast).mockClear()
})

describe("install sheet — where it goes", () => {
  test("unsigned installs machine-wide and sends no project target", async () => {
    const { activation, onDone } = harness({ mode: "unsigned" })

    expect(screen.getByText("Applies to every project on this machine")).toBeVisible()
    expect(screen.queryByRole("radiogroup", { name: "Project target" })).toBeNull()
    expect(screen.getByText("Step 1 of 1")).toBeVisible()

    await click("Add plugin")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(activation.mock.calls[0]![0]).toEqual({
      pluginInstanceId: "[\"claxedo\",\"composio\"]",
      harnessIds: HARNESSES,
      choice: true,
      expectedRevision: 4,
    })
    expect(onDone).toHaveBeenCalledWith({ installed: true, revision: 8 })
    expect(closeDialog).toHaveBeenCalled()
  })

  test("signed defaults to all projects", async () => {
    const { activation } = harness()

    await click("Add plugin")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(activation.mock.calls[0]![0].target).toEqual({ scope: "all-projects" })
  })

  test("signed sends the chosen project ids", async () => {
    const { activation } = harness()

    await click(/Only these projects/, "radio")
    await click("Project Two", "checkbox")
    await click("Add plugin")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(activation.mock.calls[0]![0].target).toEqual({ scope: "projects", projectIds: ["project-2"] })
  })

  test("an empty project selection is refused before any request", async () => {
    const { activation } = harness()

    await click(/Only these projects/, "radio")
    await click("Add plugin")

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Select at least one project"))
    expect(activation).not.toHaveBeenCalled()
  })

  test("unchecking a harness drops it from harnessIds", async () => {
    const { activation } = harness()

    await click(/codex/, "checkbox")
    await click("Add plugin")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(activation.mock.calls[0]![0].harnessIds).toEqual(["opencode", "claude", "cursor"])
  })

  test("a harness the candidate cannot serve is disabled with its reason and is not sent", async () => {
    const { activation } = harness({ plugin: candidate({ unavailable: "cursor" }) })

    expect(screen.getByRole("checkbox", { name: /cursor/ })).toBeDisabled()
    expect(screen.getByText("The plugin artifact is unavailable")).toBeVisible()

    await click("Add plugin")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(activation.mock.calls[0]![0].harnessIds).toEqual(["opencode", "claude", "codex"])
  })

  test("a failed reconciliation is reported as a pending runtime sync", async () => {
    harness({ reconciliation: { state: "failed", message: "runtime unreachable" } })

    await click("Add plugin")

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "composio installed, runtime sync pending",
      description: "runtime unreachable",
    })))
  })
})

describe("install sheet — authentication", () => {
  test("an OAuth plugin gets the second step, a plain one does not", async () => {
    harness({ plugin: candidate({ oauth: true }) })

    expect(screen.getByText("Step 1 of 2")).toBeVisible()
    await click("Next: Authentication")
    expect(screen.getByRole("radiogroup", { name: "Authentication authority" })).toBeVisible()
    expect(screen.getByText("Who authenticates composio")).toBeVisible()
  })

  test("Enterprise is disabled without both organization capabilities", async () => {
    harness({ plugin: candidate({ oauth: true }) })

    await click("Next: Authentication")
    expect(screen.getByRole("radio", { name: /Enterprise/ })).toBeDisabled()
    expect(screen.getByText("Only an organization admin can share a connection with the organization")).toBeVisible()
  })

  test("Enterprise runs activation, then organizationDefault, then a team connection", async () => {
    const { activation, organizationDefault, open, onDone, order } = harness({
      plugin: candidate({ oauth: true }),
      organizationManager: true,
    })

    await click("Next: Authentication")
    await click(/Enterprise/, "radio")
    await click("Connect now")

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(order).toEqual(["activation", "organizationDefault", "connections.open"])
    expect(organizationDefault.mock.calls[0]![0]).toEqual({
      pluginInstanceId: "[\"claxedo\",\"composio\"]",
      harnessIds: HARNESSES,
      choice: true,
      // the receipt of step 1, not the catalog revision the sheet opened with
      expectedRevision: 8,
    })
    expect(open.mock.calls[0]![0]).toEqual(expect.objectContaining({
      integrationId: "mcp-composio",
      name: "composio MCP",
      scope: "team",
      teamScopeEnabled: true,
    }))
    expect(activation.mock.calls[0]![0].expectedRevision).toBe(4)
    expect(onDone).toHaveBeenCalledWith({ installed: true, revision: 9 })
  })

  test("Personal connects with the personal scope and no organization default", async () => {
    const { organizationDefault, open, onDone } = harness({
      plugin: candidate({ oauth: true }),
      organizationManager: true,
    })

    await click("Next: Authentication")
    await click("Connect now")

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(organizationDefault).not.toHaveBeenCalled()
    expect(open.mock.calls[0]![0]).toEqual(expect.objectContaining({ scope: "personal" }))
    expect(onDone).toHaveBeenCalledWith({ installed: true, revision: 8 })
  })

  test("Connect later installs without opening a connection", async () => {
    const { activation, open, onDone } = harness({ plugin: candidate({ oauth: true }) })

    await click("Next: Authentication")
    await click("Connect later")

    await waitFor(() => expect(activation).toHaveBeenCalledTimes(1))
    expect(open).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith({ installed: true, revision: 8 })
    expect(closeDialog).toHaveBeenCalled()
  })

  test("Cancel reports that nothing was installed", async () => {
    const { activation, onDone } = harness()

    await click("Cancel")

    expect(activation).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith({ installed: false })
    expect(closeDialog).toHaveBeenCalled()
  })
})
