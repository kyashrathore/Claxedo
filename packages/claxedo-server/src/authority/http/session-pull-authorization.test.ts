import { afterEach, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, customVerifierAuthAdapter, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../services"
import { configToken, verifyWorkspaceRuntimeControlToken } from "../../workspace/supervisor/control-token"
import { runtimes, type WorkspaceRuntimeState } from "../../workspace/supervisor/store"

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  updateWorkspace: vi.fn(async () => {}),
  resolveWorkspace: async ({ workspaceId }: { workspaceId: string }) => ({
    id: workspaceId, directory: `/synthetic/${workspaceId}`, kind: "cloud",
  }),
}))

import { ControlPlaneHttpRoutes } from "./index"

const workspaceA = "ws_pull_security_a"
const workspaceB = "ws_pull_security_b"

afterEach(() => {
  runtimes.delete(workspaceA)
  runtimes.delete(workspaceB)
  vi.unstubAllEnvs()
})

function runtime(workspaceId: string): WorkspaceRuntimeState {
  const state: WorkspaceRuntimeState = {
    ws: { id: workspaceId, directory: `/synthetic/${workspaceId}`, kind: "cloud", created_at: 1, updated_at: 1 },
    status: "ready", used_at: 1, crashes: 0, retry_at: 0, active: 0, holds: [],
  }
  runtimes.set(workspaceId, state)
  return state
}

function fixture(storedWorkspace?: string, local = false) {
  const tokenA = configToken(runtime(workspaceA))
  const tokenB = configToken(runtime(workspaceB))
  const auth = local ? localOnlyAuthAdapter() : customVerifierAuthAdapter({
    issuer: "https://issuer.example.test",
    verifier: async () => { throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Not a user token") },
  })
  const projectionStore = {
    session_meta: vi.fn(async () => storedWorkspace ? { workspaceID: storedWorkspace } : undefined),
    sync_session_meta: vi.fn(async () => {}),
    sync_session_messages: vi.fn(async () => true),
    read_session_messages: () => [],
    read_session_max_event_ordinal: () => 0,
  }
  const runtimeFetch = vi.fn(async (input: { path: string; workspaceId: string }) => {
    if (input.path === "/global/health") return Response.json({ workspaceId: input.workspaceId })
    if (input.path.endsWith("/message?snapshot=1")) {
      return Response.json({ session: { id: "synthetic-session" }, messages: [], maxEventOrdinal: 1 })
    }
    return Response.json({ id: "synthetic-session", title: "Synthetic session" })
  })
  const sandboxManager = {
    register: vi.fn(async () => ({ ok: true, status: "ready" })),
    heartbeat: vi.fn(async () => ({ ok: true, status: "ready" })),
  }
  const services = { projectionStore, auth, sandbox: { sandboxManager }, relay: {}, telemetry: { capture: () => {} } } as unknown as ControlPlaneServices
  const app = ControlPlaneHttpRoutes(services, { authConfig: auth.config, verifier: auth.verifier, runtimeFetch })
  function pull(operation: string, workspaceId = workspaceA, headerWorkspace = workspaceA, token = tokenA) {
    return app.request(`http://selfhost.test/workspaces/${workspaceId}/sessions/synthetic-session/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-workspace-id": headerWorkspace, "content-type": "application/json" },
      body: "{}",
    })
  }
  return { tokenA, tokenB, pull, projectionStore, runtimeFetch, app, sandboxManager }
}

test.each([false, true])("runtime callbacks require the workspace credential with local mode %s", async (local) => {
  const subject = fixture(undefined, local)
  for (const operation of ["register", "heartbeat"] as const) {
    const callback = (workspaceId: string, headers: Record<string, string> = {}) => subject.app.request(`http://localhost/runtime/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ workspaceId, ok: true, status: "ready", directory: `/synthetic/${workspaceId}`, profile: "workspace", agentType: "opencode", model: null, ptyCount: 0, processCount: 0, activeProcessCount: 0, epoch: 2 }),
    })
    const headers = { authorization: `Bearer ${subject.tokenA}`, "x-workspace-id": workspaceA }
    expect((await callback(workspaceA)).status).toBe(local ? 403 : 401)
    expect((await callback(workspaceB, headers)).status).toBe(403)
    expect((await callback(workspaceB, { ...headers, "x-workspace-id": workspaceB })).status).toBe(local ? 403 : 401)
    expect(subject.sandboxManager[operation]).not.toHaveBeenCalled()
    expect((await callback(workspaceA, headers)).status).toBe(200)
    expect(subject.sandboxManager[operation]).toHaveBeenCalledTimes(1)
    expect(subject.sandboxManager[operation]).toHaveBeenCalledWith(workspaceA, expect.objectContaining({ epoch: 2, ok: true }))
  }
})

test.each(["register", "checkpoint", "repair"])("%s binds the verified runtime token to the route workspace", async (operation) => {
  const subject = fixture()
  const response = await subject.pull(operation, workspaceB)
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: { code: "workspace_runtime_control_token_mismatch" } })
  expect(subject.runtimeFetch).not.toHaveBeenCalled()
  expect(subject.projectionStore.session_meta).not.toHaveBeenCalled()
  expect(subject.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  expect(subject.projectionStore.sync_session_messages).not.toHaveBeenCalled()
  // Changing the header too cannot turn A's credential into B's.
  expect((await subject.pull(operation, workspaceB, workspaceB)).status).toBe(401)
})

test.each(["register", "checkpoint", "repair"])("%s rejects a stored session in another workspace before pulling", async (operation) => {
  const subject = fixture(workspaceB)
  expect((await subject.pull(operation)).status).toBe(409)
  expect(subject.runtimeFetch).not.toHaveBeenCalled()
  expect(subject.projectionStore.sync_session_meta).not.toHaveBeenCalled()
  expect(subject.projectionStore.sync_session_messages).not.toHaveBeenCalled()
})

test.each(["register", "checkpoint", "repair"])("%s accepts a runtime's own session", async (operation) => {
  const subject = fixture(workspaceA)
  expect((await subject.pull(operation)).status).toBe(200)
  expect(subject.projectionStore.sync_session_meta).toHaveBeenCalled()
  expect(subject.runtimeFetch.mock.calls.every(([input]) => input.workspaceId === workspaceA)).toBe(true)
})

test("a deployment environment token cannot override per-workspace credentials", () => {
  vi.stubEnv("WORKSPACE_RUNTIME_CONFIG_TOKEN", "synthetic-deployment-token")
  const subject = fixture()
  expect(subject.tokenA).not.toBe(subject.tokenB)
  expect(subject.tokenA).not.toBe("synthetic-deployment-token")
  expect(configToken(runtimes.get(workspaceA)!)).toBe(subject.tokenA)
  expect(verifyWorkspaceRuntimeControlToken(workspaceA, subject.tokenA)).toBe(true)
  expect(verifyWorkspaceRuntimeControlToken(workspaceB, subject.tokenA)).toBe(false)
  expect(verifyWorkspaceRuntimeControlToken(workspaceA, "synthetic-deployment-token")).toBe(false)
})
