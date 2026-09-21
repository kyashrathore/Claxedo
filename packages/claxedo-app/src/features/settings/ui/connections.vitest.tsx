import { createHarnessConnectionsCatalog } from "@/platform/query/connection-catalog"
import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { SettingsConnections } from "./connections"


const discovery = vi.hoisted(() => vi.fn())
vi.mock("@/platform/api/api", () => ({ getClaxedoServerUrl: () => "http://localhost", authFetch: discovery }))
vi.mock("@/platform/account/integrations-request", () => ({ createIntegrationsRequest: () => async () => Response.json({ integrations: [], connections: [] }) }))
vi.mock("@/features/settings/app-ports", () => ({ DialogConnectIntegration: () => null }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe("agent connection discovery rendering", () => {
  test("only reports no connections after a successful empty discovery", async () => {
    let finish!: (response: Response) => void
    discovery.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    const view = render(() => { const catalog = createHarnessConnectionsCatalog({ base: "http://localhost", request: discovery }); void catalog.refresh(); return <SettingsConnections agentConnections={catalog} /> })
    expect(view.getByText("Loading agent connections…")).toBeTruthy()
    expect(view.queryByText("No agent connections configured.")).toBeNull()
    finish(Response.json({ status: "supported", connections: [] }))
    await waitFor(() => expect(view.getByText("No agent connections configured.")).toBeTruthy())
    expect(view.queryByText("Loading agent connections…")).toBeNull()
  })

  test.each(["not-json", "{}", JSON.stringify({ status: "supported", connections: [{ capabilities: {} }] })])("shows discovery errors without claiming an empty catalog: %s", async (body) => {
    discovery.mockImplementation(async () => new Response(body))
    const view = render(() => { const catalog = createHarnessConnectionsCatalog({ base: "http://localhost", request: discovery }); void catalog.refresh(); return <SettingsConnections agentConnections={catalog} /> })
    await waitFor(() => expect(view.queryByText("Loading agent connections…")).toBeNull())
    expect(view.queryByText("No agent connections configured.")).toBeNull()
    expect(view.container.querySelector("[data-component='agent-connections-section']")?.textContent).toMatch(/Invalid|JSON|Unexpected/)
  })

  test("explains hosted unsupported discovery and hides connection management", async () => {
    discovery.mockImplementation(async () => Response.json({ status: "unsupported", reason: "operator_local_configuration" }))
    const view = render(() => { const catalog = createHarnessConnectionsCatalog({ base: "http://localhost", request: discovery }); void catalog.refresh(); return <SettingsConnections agentConnections={catalog} /> })
    await waitFor(() => expect(view.getByText("Agent connections are configured by the operator on the local host.")).toBeTruthy())
    expect(view.queryByText("No agent connections configured.")).toBeNull()
    expect(view.queryByRole("button", { name: "Remove" })).toBeNull()
    expect(discovery).toHaveBeenCalledTimes(1)
  })
})
