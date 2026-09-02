import { describe, expect, test } from "bun:test"
import { driveEmptyRuntimeDiffRoute } from "../helpers/contracts/runtime-diff"
import { createRuntimeProviderConfig } from "../helpers/contracts/provider-config"
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
  isWorkspaceListPath,
  workspaceListResponse,
  type ControlPlaneWorkspaceRow,
} from "../helpers/contracts/workspace-list"
import { isServiceCatalogPath, serviceCatalogStateResponse } from "../helpers/contracts/service-catalog"
import { isOrgListPath, orgListResponse, type ControlPlaneOrgRow } from "../helpers/contracts/org-list"
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
    expect(runtimeHarnessOptionsResponse([option])).toEqual({ options: [option] })
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

  test("drives the real provider-config router, loopback and through the relay", async () => {
    const config = createRuntimeProviderConfig({
      harness: () => "opencode",
      config: { provider: { "clinepass-2": { name: "Cline pass 2" } } },
    })

    await expect(config.handle({
      url: "http://127.0.0.1:4455/api/wr/provider-config?harness=opencode",
      method: "PATCH",
      body: JSON.stringify({ provider: "clinepass-2", disabled: true }),
    })).resolves.toEqual({
      status: 200,
      body: { harness: "opencode", disabled_providers: ["clinepass-2"] },
    })
    expect(config.disabled()).toEqual(["clinepass-2"])

    await expect(config.handle({
      url: "https://relay.test/workspaces/ws_1/api/wr/provider-config?harness=opencode",
      method: "PATCH",
      body: JSON.stringify({ provider: "clinepass-2", disabled: false }),
    })).resolves.toEqual({
      status: 200,
      body: { harness: "opencode", disabled_providers: [] },
    })
    expect(config.disabled()).toEqual([])

    // A harness this runtime does not hold configuration for answers the
    // router's own 404, not a silent success.
    await expect(config.handle({
      url: "http://127.0.0.1:4455/api/wr/provider-config?harness=claude-sdk",
      method: "PATCH",
      body: JSON.stringify({ provider: "anthropic", disabled: true }),
    })).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "provider_config_unsupported_harness" } },
    })

    expect(config.requests.map((item) => `${item.harness} ${item.directory ?? "-"}`))
      .toEqual(["opencode -", "opencode -", "claude-sdk -"])
  })

  // The row LITERALS below are typed `ControlPlaneWorkspaceRow`, which is
  // derived from the authority's own `listWorkspaces` projection — so a field
  // the authority adds, renames, or drops fails this file's typecheck rather
  // than drifting silently. What this test adds on top is the ROUTE's own
  // behavior: which rows each `?access` value returns.
  test("filters the control-plane workspace list the way both real route handlers do", () => {
    const cloud: ControlPlaneWorkspaceRow = {
      workspace_id: "ws_cloud",
      org_id: "org_1",
      project_id: "proj_1",
      display_name: "main",
      backing: "cloud-vm",
      access: "cloud",
      remote_directory: "/workspace",
      role: "owner",
    }
    const userHosted: ControlPlaneWorkspaceRow = {
      workspace_id: "ws_shared",
      org_id: "org_1",
      project_id: "proj_1",
      display_name: "shared",
      backing: "local-worktree",
      access: "user-hosted",
      remote_directory: "/repo/shared",
      role: "viewer",
      // Only a user-hosted row carries reachability — the rail reads it as
      // "host offline" before any pane opens the workspace.
      host_online: false,
    }
    const workspaces = [cloud, userHosted]

    // `?access=user-hosted` is the ONLY filtering value.
    expect(workspaceListResponse({ access: "user-hosted", workspaces })).toEqual({
      workspaces: [userHosted],
    })
    // `?access=cloud` is "what can this principal reach", not "cloud only" —
    // it answers the whole visible inventory, which is why the catalog can
    // fold the two calls without losing a row.
    expect(workspaceListResponse({ access: "cloud", workspaces })).toEqual({ workspaces })
    expect(workspaceListResponse({ access: null, workspaces })).toEqual({ workspaces })
  })

  test("matches only the BARE workspace list path, never a sibling workspace route", () => {
    expect(isWorkspaceListPath("/api/workspace")).toBe(true)
    expect(isWorkspaceListPath("/api/workspace/")).toBe(true)
    for (const pathname of [
      "/api/workspace/resolve",
      "/api/workspace/drivers",
      "/api/workspace/create",
      "/api/workspace/ws_1/connection",
      "/api/workspace/ws_1/checkpoints",
      "/api/claxedo/workspace/resolve",
    ]) {
      expect(isWorkspaceListPath(pathname)).toBe(false)
    }
  })

  test("projects the service catalog through the real browser projection", () => {
    expect(isServiceCatalogPath("/api/claxedo/services")).toBe(true)
    expect(isServiceCatalogPath("/api/claxedo/service")).toBe(false)

    // The mock composes no service provider, which is exactly the case the real
    // route answers an empty catalog for.
    expect(serviceCatalogStateResponse()).toEqual({ authenticated: true, services: [] })
    // `authenticated: false` is the authoritative sign-out the app deactivates
    // loaded services on — a pair, never an error.
    expect(serviceCatalogStateResponse({ authenticated: false })).toEqual({
      authenticated: false,
      services: [],
    })
    // Operator-only descriptor fields (entrypoint, binding, trust) must never
    // reach the browser; the projection is what strips them.
    expect(serviceCatalogStateResponse({
      services: [{
        serviceId: "documents",
        bindingName: "DOCUMENTS_SERVICE",
        protocolVersion: "claxedo.service.v1",
        schemaVersion: 1,
        state: "enabled",
        entrypoint: "https://documents.internal",
        trust: {
          environmentId: "env_1",
          deploymentId: "dep_1",
          bindingProvenance: "wrangler",
        },
      }],
    })).toEqual({
      authenticated: true,
      services: [{
        serviceId: "documents",
        protocolVersion: "claxedo.service.v1",
        schemaVersion: 1,
        state: "enabled",
      }],
    })
  })

  test("answers the org list as the bare array the switcher indexes, on the BARE path only", () => {
    expect(isOrgListPath("/api/control/orgs")).toBe(true)
    for (const pathname of [
      "/api/control/orgs/org_1/teams",
      "/api/control/orgs/org_1/ensure-default-team",
      "/api/control/organizations",
      "/api/control/sessions",
    ]) {
      expect(isOrgListPath(pathname)).toBe(false)
    }

    // A bare array, never an envelope: `listOrgs` (org-team-api.ts) parses the
    // body straight into `OrgListItem[]` and the rail switcher calls `.find` on
    // it. `[]` is the authority's own answer for a principal in no org.
    expect(orgListResponse()).toEqual([])
    const rows: ControlPlaneOrgRow[] = [{ org_id: "org_1", name: "Acme", kind: "team", role: "owner" }]
    expect(orgListResponse(rows)).toEqual(rows)
  })
})
