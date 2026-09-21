import { afterEach, describe, expect, test, vi } from "vitest"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { agentConfigHarnessRoutes } from "./harness-routes"

// Exercise the source producer without adding workspace-runtime's source tree
// to this package's declaration/typecheck compilation root.
const healthSource = new URL("../../../../workspace-runtime/src/routes/health.ts", import.meta.url).href
const { workspaceRuntimeLivenessResponse } = await import(healthSource)

vi.mock("@claxedo/server-core/agent-config/index", async (importOriginal) => ({
  ...await importOriginal<typeof import("@claxedo/server-core/agent-config/index")>(),
  loadUserConfig: vi.fn(async () => ({ connections: {} })),
  defaultHarness: vi.fn(() => undefined),
  saveUserConfig: vi.fn(),
}))
vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: vi.fn(async () => ({ id: "workspace-1", kind: "local", directory: "/project" })),
}))
vi.mock("@claxedo/server-core/workspace/http/sandbox-target-fetch", () => ({ sandboxFetch: vi.fn() }))
vi.mock("../local-auth", () => ({ localAgentConfigAllowed: vi.fn(async () => undefined) }))
vi.mock("../../workspace/sandbox-fetch-options", () => ({ sandboxFetchOptionsForRequest: vi.fn(async () => ({})) }))

afterEach(() => vi.clearAllMocks())

describe("harness routes", () => {
  test.each([
    { kind: "native" as const, harnessId: "pi" },
    { kind: "connection" as const, connectionId: "external-opencode" },
  ])("forwards the runtime's canonical $kind health selection", async (harness) => {
    const health = workspaceRuntimeLivenessResponse({ state: "ready", harness, harnessHealth: { status: "ok" }, routeAuthBoundary: "loopback-only", serviceExposure: { source: "loopback", access: "private" } })
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json(health))
    const query = harness.kind === "native" ? `nativeHarness=${harness.harnessId}` : `connectionId=${harness.connectionId}`
    const response = await agentConfigHarnessRoutes().request(`/harness?workspaceId=workspace-1&${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(health)
    expect(health).toMatchObject({ harness, activeHarness: harness })
  })
  test("forwards the exact old session and generic connection to health", async () => {
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json({ ready: true, status: "ok" }))
    const response = await agentConfigHarnessRoutes().request("/harness?connectionId=openclaw&sessionId=three-day-old&workspaceId=workspace-1")
    expect(response.status).toBe(200)
    const request = new URL(vi.mocked(sandboxFetch).mock.calls[0][1], "http://runtime.test")
    expect(request.pathname).toBe("/api/wr/health")
    expect(Object.fromEntries(request.searchParams)).toEqual({ directory: "/project", connectionId: "openclaw", sessionId: "three-day-old" })
  })

  test("preserves runtime model-discovery failure without a catalog fallback", async () => {
    const error = { error: { code: "harness_unavailable", message: "Connection disabled" } }
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json(error, { status: 409 }))
    const response = await agentConfigHarnessRoutes().request("/harness/options?connectionId=openclaw&workspaceId=workspace-1")
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(error)
    expect(vi.mocked(sandboxFetch).mock.calls[0][1]).toBe("/api/wr/harness-config-options?directory=%2Fproject&connectionId=openclaw")
  })

  test("resolves the workspace read-only: a directory-scoped GET carries no create flag", async () => {
    vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json({ options: [] }))
    const response = await agentConfigHarnessRoutes().request("/harness/options?connectionId=external-opencode&directory=/unregistered")
    expect(response.status).toBe(200)
    expect(resolveWorkspace).toHaveBeenCalledWith({ workspaceId: undefined, directory: "/unregistered" })
  })

  test("does not silently choose OpenCode when no selection exists", async () => {
    const response = await agentConfigHarnessRoutes().request("/harness")
    expect(await response.json()).toEqual({ status: "unconfigured", ready: false })
    expect(sandboxFetch).not.toHaveBeenCalled()
    const options = await agentConfigHarnessRoutes().request("/harness/options")
    expect(options.status).toBe(400)
  })
})
