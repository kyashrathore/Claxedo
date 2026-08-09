import { describe, expect, test } from "bun:test"
import { driveEmptyRuntimeDiffRoute } from "../helpers/contracts/runtime-diff"
import { readyRuntimeHealthResponse } from "../helpers/contracts/runtime-health"
import { emptySessionNavigationListResponse } from "../helpers/contracts/session-list"
import { emptySessionInventoryResponse } from "../helpers/contracts/session-inventory"
import {
  localHarnessOptionsResponse,
  runtimeHarnessOptionsResponse,
  type BoundHarnessConfigOption,
} from "../helpers/contracts/harness-options"
import { workspaceResolveResponse } from "../helpers/contracts/workspace-resolve"
import { unconfiguredWorkspaceDriversResponse } from "../helpers/contracts/workspace-drivers"
import {
  activeWorktreeResponse,
  parseWorktreeCreateBody,
  WORKTREE_CREATE_SUCCESS_STATUS,
} from "../helpers/contracts/worktrees"
import {
  centralStreamHeartbeat,
  runtimeStreamHeartbeat,
  sseFrame,
  workspaceStreamHeartbeat,
} from "../helpers/contracts/sse"

const option: BoundHarnessConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "openai/test",
  selectOptions: [{ id: "openai/test", name: "OpenAI Test" }],
}

describe("mock-runtime canonical route bindings", () => {
  test("encodes each SSE family with the shared wire encoder and canonical heartbeat shape", () => {
    expect(sseFrame({ type: "event" }, "7")).toBe('id: 7\ndata: {"type":"event"}\n\n')
    expect(workspaceStreamHeartbeat(4)).toBe('id: 4\ndata: {"type":"heartbeat"}\n\n')
    expect(runtimeStreamHeartbeat()).toBe('data: {"type":"heartbeat"}\n\n')
    const central = centralStreamHeartbeat(9)
    expect(central.startsWith('id: 9\ndata: {"directory":"global","payload":{"id":"')).toBe(true)
    expect(central.endsWith('","type":"server.connected","properties":{}}}\n\n')).toBe(true)
  })

  test("keeps local and runtime harness-option response contracts distinct", () => {
    expect(localHarnessOptionsResponse([option])).toEqual({
      source: "harness",
      stale: false,
      options: [option],
    })
    expect(runtimeHarnessOptionsResponse([option])).toEqual([option])
  })

  test("derives session-list view fields from the real query parser", () => {
    expect(emptySessionNavigationListResponse(
      "http://app.test/api/control/session-list?scope=workspace&groupBy=none&sort=created_asc&limit=7&workspaceId=ws_1",
    )).toEqual({
      view: {
        scope: "workspace",
        groupBy: "none",
        sort: "updated_desc",
        limit: 7,
      },
      items: [],
      totalKnown: 0,
    })
  })

  test("uses the canonical flat control-plane session inventory envelope", () => {
    expect(emptySessionInventoryResponse()).toEqual({ sessions: [] })
  })

  test("projects workspace resolve through the server-owned response producer", () => {
    const response = workspaceResolveResponse({
      id: "ws_cloud",
      project_id: "project_1",
      directory: "workspace:ws_cloud",
      remote_directory: "/repo/cloud",
      kind: "cloud",
      driver: "daytona",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    expect(response).toMatchObject({
      workspaceId: "ws_cloud",
      projectId: "project_1",
      directory: "/repo/cloud",
      access: "cloud",
      kind: "cloud",
      driver: "daytona",
      status: "ready",
    })
    expect(response).not.toHaveProperty("projectID")
  })

  test("derives the unconfigured workspace-driver list from the real catalog", () => {
    const response = unconfiguredWorkspaceDriversResponse()
    expect(response.default_driver).toBe("daytona")
    expect(response.drivers.map((driver) => driver.id)).toEqual([
      "exe",
      "daytona",
      "modal",
      "vercel",
      "cloudflare",
      "box",
    ])
    expect(response.drivers.filter((driver) => driver.configured)).toEqual([])
    expect(response.drivers.find((driver) => driver.default)?.id).toBe("daytona")
  })

  test("uses the real runtime liveness field contract", () => {
    expect(readyRuntimeHealthResponse("codex")).toEqual({
      ok: true,
      status: "ready",
      service: "workspace-runtime",
      routeAuthBoundary: "relay-host-auth",
      serviceExposure: {
        source: "driver-service-url",
        access: "driver-authenticated",
      },
      exposure: { kind: "relay" },
      agentType: "codex",
      acpBinary: null,
      error: null,
      harnessHealth: { status: "ok" },
    })
  })

  test("validates worktree admission and returns the real 201 record shape", () => {
    expect(parseWorktreeCreateBody({})).toEqual({
      ok: false,
      status: 400,
      body: { error: { code: "worktree_invalid_session", message: "sessionId is required" } },
    })
    expect(WORKTREE_CREATE_SUCCESS_STATUS).toBe(201)
    expect(activeWorktreeResponse({
      workspaceId: "ws_1",
      sessionId: "session_1",
      path: "/repo/worktree",
      now: 10,
    })).toEqual({
      worktree: {
        workspaceId: "ws_1",
        sessionId: "session_1",
        path: "/repo/worktree",
        branch: "claxedo/session/session_1",
        baseCommit: "e2e-base-commit",
        state: "active",
        createdAt: 10,
        updatedAt: 10,
        lastActivityAt: 10,
      },
    })
  })

  test("drives the real diff router for defaults, validation, and response shape", async () => {
    await expect(driveEmptyRuntimeDiffRoute(
      "https://relay.test/workspaces/ws_1/api/wr/diff/targets",
    )).resolves.toEqual({
      status: 200,
      body: { defaultRef: "HEAD", candidates: ["HEAD"] },
    })
    await expect(driveEmptyRuntimeDiffRoute(
      "https://relay.test/workspaces/ws_1/api/wr/diff/vcs/file",
    )).resolves.toEqual({
      status: 400,
      body: {
        error: {
          code: "diff_file_required",
          message: "Missing required query param: file",
        },
      },
    })
    await expect(driveEmptyRuntimeDiffRoute(
      "https://relay.test/workspaces/ws_1/api/wr/diff/vcs/file?file=README.md",
    )).resolves.toEqual({
      status: 200,
      body: { file: "README.md", patch: "" },
    })
  })
})
