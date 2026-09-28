import { afterEach, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { WorkspaceRuntimeRequestError } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { sandboxFetchOptionsForRequest } from "../workspace/sandbox-fetch-options"
import { workspaceProviderCatalog } from "./workspace-provider-catalog"

vi.mock("@claxedo/server-core/workspace/store/index", async (original) => ({
  ...await original<typeof import("@claxedo/server-core/workspace/store/index")>(), resolveWorkspace: vi.fn(),
}))
vi.mock("@claxedo/server-core/workspace/http/sandbox-target-fetch", () => ({ sandboxFetch: vi.fn() }))
vi.mock("../workspace/sandbox-fetch-options", () => ({ sandboxFetchOptionsForRequest: vi.fn() }))
afterEach(() => vi.resetAllMocks())
const app = new Hono().get("/", async (c) => c.json(await workspaceProviderCatalog(c, {
  authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "test" },
}, "org") ?? { engine: "none" }))

function workspace() {
  vi.mocked(resolveWorkspace).mockResolvedValue({ id: "ws", kind: "local", directory: "/project", created_at: 1, updated_at: 1 })
}

test("the exact directory is resolved and owner authorization precedes the workspace catalog read", async () => {
  workspace()
  vi.mocked(sandboxFetchOptionsForRequest).mockResolvedValue({ orgId: "org", role: "owner" })
  vi.mocked(sandboxFetch).mockResolvedValue(Response.json([{ id: "acme", name: "Acme", env: [], connected: true, models: [{ providerID: "acme", id: "one", cost: [] }] }]))
  const response = await app.request("/?directory=%2Fproject")
  expect(response.status).toBe(200)
  expect(resolveWorkspace).toHaveBeenCalledWith({ directory: "/project", workspaceId: undefined })
  expect(sandboxFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "ws" }),
    "/api/wr/harness-providers?nativeHarness=opencode&directory=%2Fproject", undefined, { orgId: "org", role: "owner" })
})

for (const role of ["viewer", "editor", "admin"] as const) test(`${role} cannot read the owner's catalog`, async () => {
  workspace()
  vi.mocked(sandboxFetchOptionsForRequest).mockResolvedValue({ orgId: "org", role })
  expect((await app.request("/?directory=%2Fproject")).status).toBe(403)
  expect(sandboxFetch).not.toHaveBeenCalled()
})

test("another org and an unknown workspace cannot borrow a catalog", async () => {
  workspace()
  vi.mocked(sandboxFetchOptionsForRequest).mockResolvedValue({ orgId: "other", role: "owner" })
  expect((await app.request("/?directory=%2Fproject")).status).toBe(403)
  vi.mocked(resolveWorkspace).mockResolvedValue(undefined)
  expect((await app.request("/?directory=%2Felsewhere")).status).toBe(404)
  expect(sandboxFetch).not.toHaveBeenCalled()
})

test("a request naming no workspace has no engine to ask, and reads nothing", async () => {
  const response = await app.request("/")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ engine: "none" })
  expect(resolveWorkspace).not.toHaveBeenCalled()
  expect(sandboxFetch).not.toHaveBeenCalled()
})

test("a cloud workspace whose sandbox is not running is read without starting it", async () => {
  vi.mocked(resolveWorkspace).mockResolvedValue({ id: "ws", kind: "cloud", directory: "/workspace", created_at: 1, updated_at: 1 })
  vi.mocked(sandboxFetchOptionsForRequest).mockResolvedValue({ orgId: "org", role: "owner" })
  vi.mocked(sandboxFetch).mockRejectedValue(new WorkspaceRuntimeRequestError({ operation: "resolve", status: 503, code: "sandbox_unavailable", message: "stopped" }))
  const response = await app.request("/?directory=workspace%3Aws")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ engine: "none" })
  expect(sandboxFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "ws" }), expect.any(String), undefined, { orgId: "org", role: "owner", resume: false })
})

test("workspace directory references resolve the named workspace", async () => {
  workspace()
  vi.mocked(sandboxFetchOptionsForRequest).mockResolvedValue({ orgId: "org", role: "owner" })
  vi.mocked(sandboxFetch).mockResolvedValue(Response.json([]))
  expect((await app.request("/?directory=workspace%3Aws")).status).toBe(200)
  expect(resolveWorkspace).toHaveBeenCalledWith({ directory: "workspace:ws", workspaceId: "ws" })
})
