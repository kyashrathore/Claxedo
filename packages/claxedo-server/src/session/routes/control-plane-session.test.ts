import { beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
}))

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
}))

import { ControlPlaneSessionRoutes } from "./control-plane-session"

function services(): ControlPlaneServices {
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      // ProjectionStore requires `read_session_max_event_ordinal`.
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
  }
}

/** A cloud workspace: the list read looks at the kind before choosing its source. */
function cloudWorkspaceOpen() {
  return vi.fn(async () => ({ role: "owner", workspace: { access: "cloud", backing: "cloud-vm", org_id: "org_1" } }))
}

function servicesWithWorkspaceOpenAuthorization(
  authorizeWorkspaceOpen: NonNullable<ControlPlaneServices["authority"]>["authorizeWorkspaceOpen"],
) {
  const svc = services()
  svc.authority = { authorizeWorkspaceOpen } as never
  return svc
}

const signedOptions = {
  authConfig: {
    enabled: true as const,
    issuer: "https://auth.example.test",
    jwksUrl: "custom:test",
  },
  verifier: vi.fn(async (token: string) => ({
    mode: "signed" as const,
    token,
    user: {
      subject: "user_1",
      tokenIdentifier: "token_1",
      issuer: "https://auth.example.test",
    },
  })),
}

function sessionMeta(input: {
  id: string
  workspaceID?: string
  projectID?: string
  directory?: string
  updatedAt: number
  archived?: number
  tags?: string[]
}) {
  return {
    sessionID: input.id,
    workspaceID: input.workspaceID ?? "ws_1",
    projectID: input.projectID ?? "proj_1",
    host: "workspace" as const,
    directory: input.directory ?? "/repo",
    title: input.id,
    createdAt: 1,
    updatedAt: input.updatedAt,
    ...(input.archived ? { archived: input.archived } : {}),
    tags: input.tags ?? [],
    attachments: [],
  }
}

describe("control plane session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
  })

  test("rejects oversized participant mutations before parsing or authentication", async () => {
    const response = await ControlPlaneSessionRoutes(services(), signedOptions).request(
      "https://control.example.test/sessions/session-1/participants",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(17 * 1024),
        },
        body: JSON.stringify({ participantTokenIdentifier: "x".repeat(17 * 1024), workspaceId: "ws_1" }),
      },
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "request_body_too_large" } })
    expect(signedOptions.verifier).not.toHaveBeenCalled()
  })

  test("does not expose direct sandbox URLs as hosted session gateways", async () => {
    const svc = services()
    svc.defaultHomeRegion = "eu-west"
    const ensure = vi.fn(async () => ({
      status: "ready" as const,
      url: "https://runtime.example.com/",
      hostId: "host_1",
      sandboxId: "sandbox_1",
      epoch: 1,
      homeRegion: "eu-west" as const,
    }))
    svc.sandbox.sandboxManager = {
      ensure,
    } as never
    svc.authority = { authorizeSessionRead: vi.fn(async () => {}) } as never
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      host: "workspace" as const,
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))
    const app = ControlPlaneSessionRoutes(svc, signedOptions)

    const res = await app.request("https://control.example.test/sessions/session-1/gateway", {
      headers: { Authorization: "Bearer signed-token" },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: null,
      harnessHost: "workspace",
    })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("does not consult sandbox manager when resolving browser session gateway URLs", async () => {
    const svc = services()
    svc.defaultHomeRegion = "eu-west"
    const ensure = vi.fn(async () => ({
      status: "unavailable" as const,
      error: "runtime_lease_not_ready",
      homeRegion: "eu-west" as const,
    }))
    svc.sandbox.sandboxManager = {
      ensure,
    } as never
    svc.authority = { authorizeSessionRead: vi.fn(async () => {}) } as never
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      host: "workspace" as const,
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/sessions/session-1/gateway",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: null,
      harnessHost: "workspace",
    })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("returns no workspace gateway without exposing runtime host details", async () => {
    const svc = services()
    svc.authority = { authorizeSessionRead: vi.fn(async () => {}) } as never
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      host: "workspace" as const,
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/sessions/session-1/gateway",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: null,
      harnessHost: "workspace",
    })
  })

  test("rejects unsigned session gateway resolution", async () => {
    const res = await ControlPlaneSessionRoutes(services(), signedOptions).request(
      "https://control.example.test/sessions/session-1/gateway",
    )

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "missing_bearer_token",
        message: "Authorization: Bearer token is required",
      },
    })
  })

  test("serves loopback session gateway metadata from the local projection", async () => {
    const svc = services()
    const authority = {
      authorizeSessionRead: vi.fn(async () => {}),
    }
    svc.authority = authority as never
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      host: "workspace" as const,
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/sessions/session-1/gateway",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: null,
      harnessHost: "workspace",
    })
    expect(svc.projectionStore.session_meta).toHaveBeenCalledWith("session-1")
    expect(authority.authorizeSessionRead).not.toHaveBeenCalled()
  })

  test("routes loopback bearer inventory and replay through signed authority without browser-only headers", async () => {
    const svc = services()
    const authority = {
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => [
        {
          session_id: "session-1",
          title: "Signed session",
          created_at: 1,
          updated_at: 2,
        },
      ]),
      readSessionMessages: vi.fn(async () => ({
        messages: [
          {
            info: { id: "msg_1", sessionID: "session-1", role: "user" },
            parts: [{ id: "part_1", messageID: "msg_1", text: "hello" }],
          },
        ],
      })),
      authorizeSessionRead: vi.fn(async () => {}),
    }
    svc.authority = authority as never
    svc.projectionStore.list_session_metas = vi.fn(async () => {
      throw new Error("signed inventory must not read the unfiltered local projection")
    })
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 7)
    const app = ControlPlaneSessionRoutes(svc, {
      authConfig: {
        enabled: true,
        issuer: "https://auth.example.test",
        jwksUrl: "custom:test",
      },
      verifier: async (token) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `test:${token}`,
          issuer: "https://auth.example.test",
        },
      }),
    })

    const list = await app.request("http://127.0.0.1/sessions?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    const messages = await app.request("http://127.0.0.1/sessions/session-1/messages?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    const capabilities = await app.request(
      "https://control.example.test/sessions/session-1/capabilities?workspaceId=ws_1",
      {
        headers: { Authorization: "Bearer user_1" },
      },
    )

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      sessions: [{ session_id: "session-1", title: "Signed session" }],
    })
    expect(messages.status).toBe(200)
    await expect(messages.json()).resolves.toMatchObject({
      messages: [{ info: { id: "msg_1" } }],
      maxEventOrdinal: 7,
    })
    expect(capabilities.status).toBe(409)
    await expect(capabilities.json()).resolves.toMatchObject({
      error: { code: "session_harness_missing" },
    })
    svc.projectionStore.session_meta = vi.fn(async () => ({ host: "workspace", tags: ["harness:pi"] }) as never)
    const boundCapabilities = await app.request("https://control.example.test/sessions/session-1/capabilities?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    expect(boundCapabilities.status).toBe(200)
    await expect(boundCapabilities.json()).resolves.toMatchObject({ transport: "pi", replay: true })
    expect(authority.listSessions).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      workspaceId: "ws_1",
    })
    expect(authority.readSessionMessages).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })
    expect(authority.authorizeSessionRead).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })
  })

  test("keeps a signed workspace page on the authority cursor chain", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({
        allowed: true,
        messages: [{ info: { id: "msg_workspace_page", role: "assistant" }, parts: [] }],
        nextCursor: "authority-next",
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => {
      throw new Error("bounded workspace reads must not fall back to full projection history")
    })
    svc.projectionStore.read_session_message_page = vi.fn(() => {
      throw new Error("workspace authority cursors must not switch to the central projection")
    })
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 18)
    const app = ControlPlaneSessionRoutes(svc, signedOptions)

    const response = await app.request(
      "https://control.example.test/sessions/session-1/messages?workspaceId=ws_1&limit=25&before=authority-before",
      { headers: { Authorization: "Bearer signed-token" } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-next-cursor")).toBe("authority-next")
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Next-Cursor")
    await expect(response.json()).resolves.toMatchObject({
      allowed: true,
      messages: [{ info: { id: "msg_workspace_page" } }],
      maxEventOrdinal: 18,
    })
    expect(authority.readSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({ token: "signed-token" }),
      {
        sessionId: "session-1",
        workspaceId: "ws_1",
        limit: 25,
        before: "authority-before",
      },
    )
    expect(svc.projectionStore.read_session_messages).not.toHaveBeenCalled()
    expect(svc.projectionStore.read_session_message_page).not.toHaveBeenCalled()
  })

  test("serves loopback session-list rows without injecting a route-active session", async () => {
    const svc = services()
    svc.projectionStore.list_session_metas = vi.fn(async () => [
      {
        sessionID: "ses_visible",
        workspaceID: "ws_1",
        projectID: "proj_1",
        host: "workspace" as const,
        directory: "/repo",
        title: "Visible",
        createdAt: 1,
        updatedAt: 3,
        tags: [],
        attachments: [],
      },
    ])

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&limit=10&activeSessionId=ses_route_only",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 10 },
      items: [{ sessionId: "ses_visible", type: "session", title: "Visible" }],
      totalKnown: 1,
    })
    expect(svc.projectionStore.list_session_metas).toHaveBeenCalledWith({
      directory: "/repo",
      includeArchived: false,
    })
  })

  test("reconciles local runtime metadata before reading the sidebar projection", async () => {
    const svc = services()
    let reconciled = false
    svc.projectionStore.list_session_navigation_metas = vi.fn(async () => {
      expect(reconciled).toBe(true)
      return [{ ...sessionMeta({ id: "ses_titled", updatedAt: 2 }), title: "Generated after first turn" }]
    })

    const res = await ControlPlaneSessionRoutes(svc, {
      ...signedOptions,
      beforeLocalList: async () => {
        reconciled = true
      },
    }).request("http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&limit=10")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [{ sessionId: "ses_titled", title: "Generated after first turn" }],
    })
  })

  test("serves ungrouped loopback session-list pages from bounded projection queries", async () => {
    const svc = services()
    svc.projectionStore.list_session_metas = vi.fn(async () => {
      throw new Error("broad list should not be used")
    })
    svc.projectionStore.list_session_navigation_metas = vi.fn(async () => [
      sessionMeta({ id: "ses_2", updatedAt: 20 }),
      sessionMeta({ id: "ses_1", updatedAt: 10 }),
    ])

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&limit=1",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [{ sessionId: "ses_2" }],
      nextCursor: expect.any(String),
    })
    expect(svc.projectionStore.list_session_navigation_metas).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "/repo",
        global: false,
        archived: "active",
        status: [],
        limit: 2,
      }),
    )
    expect(svc.projectionStore.list_session_metas).not.toHaveBeenCalled()
  })

  test("session-list filters before applying keyset pagination", async () => {
    const svc = services()
    svc.projectionStore.list_session_metas = vi.fn(async () => [
      sessionMeta({ id: "ses_skip", updatedAt: 30, tags: ["review"] }),
      sessionMeta({ id: "ses_keep_2", updatedAt: 20, tags: ["planner"] }),
      sessionMeta({ id: "ses_keep_1", updatedAt: 10, tags: ["planner"] }),
    ])

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&status=planner&limit=1",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(res.status).toBe(200)
    const first = (await res.json()) as { items: Array<{ sessionId: string }>; nextCursor: string }
    expect(first.items.map((item) => item.sessionId)).toEqual(["ses_keep_2"])

    const next = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      `http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&status=planner&limit=1&cursor=${first.nextCursor}`,
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(next.status).toBe(200)
    await expect(next.json()).resolves.toMatchObject({
      items: [{ sessionId: "ses_keep_1" }],
    })
  })

  test("session-list rejects cursors from a different query shape", async () => {
    const svc = services()
    svc.projectionStore.list_session_metas = vi.fn(async () => [
      sessionMeta({ id: "ses_2", updatedAt: 20, tags: ["planner"] }),
      sessionMeta({ id: "ses_1", updatedAt: 10, tags: ["planner"] }),
    ])
    const first = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&status=planner&limit=1",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )
    const body = (await first.json()) as { nextCursor: string }

    const mismatch = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      `http://127.0.0.1/session-list?scope=workspace&directory=%2Frepo&status=review&limit=1&cursor=${body.nextCursor}`,
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(mismatch.status).toBe(400)
    await expect(mismatch.json()).resolves.toEqual({
      error: {
        code: "invalid_session_list_cursor",
        message: "Session list cursor does not match this query",
      },
    })
  })

  test("session-list groups durable sessions deterministically", async () => {
    const svc = services()
    svc.projectionStore.list_session_metas = vi.fn(async () => [
      sessionMeta({ id: "ses_b", workspaceID: "ws_b", directory: "/b", updatedAt: 20 }),
      sessionMeta({ id: "ses_a", workspaceID: "ws_a", directory: "/a", updatedAt: 10 }),
    ])

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=workspace&groupBy=workspace&archived=all&limit=10",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      groups: [
        { id: "ws_a", items: [{ sessionId: "ses_a" }] },
        { id: "ws_b", items: [{ sessionId: "ses_b" }] },
      ],
    })
  })

  test("serves signed session-list through the same logical response shape", async () => {
    const svc = services()
    const authority = {
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => [
        {
          session_id: "session-1",
          workspace_id: "ws_1",
          title: "Signed session",
          created_at: 1,
          updated_at: 2,
        },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?workspaceId=ws_1&limit=5",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [
        {
          type: "session",
          sessionId: "session-1",
          sessionRef: "workspace:ws_1:session:session-1",
          title: "Signed session",
          workspaceId: "ws_1",
        },
      ],
    })
    expect(authority.listSessions).toHaveBeenCalledWith(expect.objectContaining({ token: "signed-token" }), {
      workspaceId: "ws_1",
    })
  })

  test("serves signed project-scoped workspace session-list through workspace authority", async () => {
    const svc = services()
    const authority = {
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => [
        {
          session_id: "session-1",
          workspace_id: "ws_1",
          title: "Signed session",
          created_at: 1,
          updated_at: 2,
        },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=project&projectId=ws_1&limit=5",
      {
        headers: {
          Authorization: "Bearer signed-token",
          Origin: "http://127.0.0.1:4444",
          "x-claxedo-directory": "workspace:ws_1",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [{ sessionId: "session-1", workspaceId: "ws_1" }],
    })
    expect(authority.listSessions).toHaveBeenCalledWith(expect.objectContaining({ token: "signed-token" }), {
      workspaceId: "ws_1",
    })
  })

  test("resolves a non-ws_ project id to its workspaces instead of rejecting", async () => {
    const svc = services()
    const authority = {
      listWorkspaces: vi.fn(async () => [
        { workspace_id: "ws_a", project_id: "proj_alpha" },
        { workspace_id: "ws_b", project_id: "proj_alpha" },
        { workspace_id: "ws_other", project_id: "proj_beta" },
      ]),
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async (_auth: unknown, args: { workspaceId: string }) =>
        args.workspaceId === "ws_a"
          ? [{ session_id: "ses_a", title: "From A", created_at: 1, updated_at: 2 }]
          : args.workspaceId === "ws_b"
            ? [{ session_id: "ses_b", title: "From B", created_at: 1, updated_at: 3 }]
            : [{ session_id: "ses_other", title: "Other project", created_at: 1, updated_at: 9 }],
      ),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?scope=project&projectId=proj_alpha&limit=5",
      { headers: { Authorization: "Bearer signed-token" } },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as {
      view: { scope: string }
      items: Array<{ sessionId: string; workspaceId?: string; projectId?: string; sessionRef: string }>
    }
    expect(body.view.scope).toBe("project")
    // Sorted updated_desc: ws_b's session (3) before ws_a's (2). The
    // ws_other workspace belongs to another project and must not leak in.
    expect(body.items.map((item) => item.sessionId)).toEqual(["ses_b", "ses_a"])
    expect(body.items.map((item) => item.workspaceId)).toEqual(["ws_b", "ws_a"])
    expect(body.items.every((item) => item.projectId === "proj_alpha")).toBe(true)
    expect(body.items.map((item) => item.sessionRef)).toEqual([
      "workspace:ws_b:session:ses_b",
      "workspace:ws_a:session:ses_a",
    ])
    expect(authority.listSessions).not.toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_other" })
  })

  test("returns an empty project session-list when the project has no workspaces", async () => {
    const svc = services()
    const authority = {
      listWorkspaces: vi.fn(async () => [{ workspace_id: "ws_a", project_id: "proj_other" }]),
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => []),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?scope=project&projectId=proj_missing&limit=5",
      { headers: { Authorization: "Bearer signed-token" } },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ view: { scope: "project" }, items: [], totalKnown: 0 })
    expect(authority.listSessions).not.toHaveBeenCalled()
  })

  test("session-list matches prefixed environment and git filter values", async () => {
    const svc = services()
    const authority = {
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => [
        {
          session_id: "session-match",
          workspace_id: "ws_1",
          title: "Match",
          created_at: 1,
          updated_at: 3,
          environment: { kind: "cloud", driver: "daytona" },
          git: { repo: "claxedo", branch: "main" },
        },
        {
          session_id: "session-skip",
          workspace_id: "ws_1",
          title: "Skip",
          created_at: 1,
          updated_at: 2,
          environment: { kind: "cloud", driver: "other" },
          git: { repo: "claxedo", branch: "dev" },
        },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?workspaceId=ws_1&environment=driver:daytona&git=branch:main&limit=10",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      items: [{ sessionId: "session-match" }],
      totalKnown: 1,
    })
    expect(body.items[0].environment).toEqual({ kind: "cloud", driver: "daytona" })
  })

  test("session-list does not accept legacy provider environment filters", async () => {
    const svc = services()
    const authority = {
      openWorkspace: cloudWorkspaceOpen(),

      listSessions: vi.fn(async () => [
        {
          session_id: "session-match",
          workspace_id: "ws_1",
          title: "Match",
          created_at: 1,
          updated_at: 3,
          environment: { kind: "cloud", driver: "daytona" },
        },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?workspaceId=ws_1&environment=provider:daytona&limit=10",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [],
      totalKnown: 0,
    })
  })

  test("serves loopback session messages from the local projection", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({ messages: [] })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [
      {
        info: { id: "msg_local", sessionID: "session-1", role: "user" },
        parts: [{ id: "part_local", messageID: "msg_local", type: "text", text: "local replay" }],
      },
    ])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 9)

    const messages = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/sessions/session-1/messages?workspaceId=ws_1",
      {
        headers: {
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(messages.status).toBe(200)
    await expect(messages.json()).resolves.toEqual({
      messages: [
        {
          info: { id: "msg_local", sessionID: "session-1", role: "user" },
          parts: [{ id: "part_local", messageID: "msg_local", type: "text", text: "local replay" }],
        },
      ],
      maxEventOrdinal: 9,
    })
    expect(svc.projectionStore.read_session_messages).toHaveBeenCalledWith("session-1")
    expect(authority.readSessionMessages).not.toHaveBeenCalled()
  })

  test("loopback workspace session messages fall back to authority when projection is empty", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({
        allowed: true,
        messages: [
          {
            info: { id: "msg_workspace", sessionID: "session-1", role: "assistant" },
            parts: [{ id: "part_workspace", messageID: "msg_workspace", type: "text", text: "workspace replay" }],
          },
        ],
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 0)

    const messages = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/sessions/session-1/messages?workspaceId=ws_1",
      {
        headers: {
          Authorization: "Bearer local-test-token",
          Origin: "http://127.0.0.1:4444",
        },
      },
    )

    expect(messages.status).toBe(200)
    await expect(messages.json()).resolves.toMatchObject({
      allowed: true,
      messages: [
        {
          info: { id: "msg_workspace" },
          parts: [{ id: "part_workspace", text: "workspace replay" }],
        },
      ],
      maxEventOrdinal: 0,
    })
    expect(authority.readSessionMessages).toHaveBeenCalledWith(expect.objectContaining({ token: "local-test-token" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })
  })

  test("signed hosted browser loopback session messages use the authority path", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({
        messages: [
          {
            info: { id: "msg_hosted", sessionID: "session-1", role: "user" },
            parts: [{ id: "part_hosted", messageID: "msg_hosted", type: "text", text: "hosted replay" }],
          },
        ],
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 0)

    const messages = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/sessions/session-1/messages?workspaceId=ws_1",
      {
        headers: {
          Authorization: "Bearer hosted-test-token",
          Origin: "http://127.0.0.1:4444",
          "x-claxedo-directory": "/workspace/hosted",
        },
      },
    )

    expect(messages.status).toBe(200)
    await expect(messages.json()).resolves.toMatchObject({
      messages: [
        {
          info: { id: "msg_hosted" },
          parts: [{ id: "part_hosted", text: "hosted replay" }],
        },
      ],
      maxEventOrdinal: 0,
    })
    expect(authority.readSessionMessages).toHaveBeenCalledWith(expect.objectContaining({ token: "hosted-test-token" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })
  })

  test("signed messages prefer durable projection replay when available", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({ messages: [] })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [
      {
        info: { id: "msg_replay", sessionID: "session-1", role: "user" },
        parts: [{ id: "part_replay", messageID: "msg_replay", type: "text", text: "persisted replay" }],
      },
    ])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 2)
    const app = ControlPlaneSessionRoutes(svc, {
      authConfig: {
        enabled: true,
        issuer: "https://auth.example.test",
        jwksUrl: "custom:test",
      },
      verifier: async (token) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `test:${token}`,
          issuer: "https://auth.example.test",
        },
      }),
    })

    const messages = await app.request("https://control.example.test/sessions/session-1/messages?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(messages.status).toBe(200)
    await expect(messages.json()).resolves.toMatchObject({
      messages: [
        {
          info: { id: "msg_replay" },
          parts: [{ id: "part_replay", text: "persisted replay" }],
        },
      ],
      maxEventOrdinal: 2,
    })
    expect(authority.readSessionMessages).toHaveBeenCalled()
  })
})

describe("machine session admission", () => {
  const request = (body: unknown, signed = false) => new Request(signed ? "https://control.example.test/sessions" : "http://127.0.0.1/sessions", { method: "POST", headers: { "content-type": "application/json", ...(signed ? { Authorization: "Bearer account" } : {}) }, body: JSON.stringify(body) })
  test("passes the selected machine, native harness and model to the admission owner", async () => {
    const createMachineSession = vi.fn(async () => ({ id: "native-session" }))
    const app = ControlPlaneSessionRoutes(services(), { createMachineSession })
    const response = await app.request(request({ workspaceId: "ws_1", harness: "pi", title: "Coding", model: { providerID: "anthropic", modelID: "selected" } }))
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ session: { id: "native-session" } })
    expect(createMachineSession).toHaveBeenCalledWith({ workspaceId: "ws_1", harness: { id: "pi", access: "native" }, title: "Coding", model: { providerID: "anthropic", modelID: "selected" } }, undefined)
  })
  test.each([
    {}, { harness: "pi" }, { workspaceId: "ws_1" }, { workspaceId: "ws_1", harness: "invalid" },
    { workspaceId: "ws_1", harness: "pi", mode: "hybrid" },
    { workspaceId: "ws_1", harness: "pi", host: "central" },
    { workspaceId: "ws_1", harness: "pi", toolSandbox: { kind: "virtual" } },
    { workspaceId: "ws_1", harness: "pi", model: { modelID: "missing-provider" } },
    { workspaceId: "ws_1", harness: "pi", title: 42 }, [], null,
  ])("rejects invalid or removed contracts before native admission: %j", async body => {
    const createMachineSession = vi.fn(async () => ({ id: "unwanted" }))
    const response = await ControlPlaneSessionRoutes(services(), { createMachineSession }).request(request(body))
    expect(response.status).toBe(400)
    expect(createMachineSession).not.toHaveBeenCalled()
  })
  test("authorizes the signed workspace and forwards the verified identity", async () => {
    const authorizeWorkspaceOpen = vi.fn(async () => {})
    const createMachineSession = vi.fn(async () => ({ id: "authorized" }))
    const response = await ControlPlaneSessionRoutes(servicesWithWorkspaceOpenAuthorization(authorizeWorkspaceOpen), { ...signedOptions, createMachineSession }).request(request({ workspaceId: "ws_1", harness: "pi" }, true))
    expect(response.status).toBe(201)
    expect(authorizeWorkspaceOpen).toHaveBeenCalledWith(expect.objectContaining({ token: "account" }), { workspaceId: "ws_1" })
    expect(createMachineSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "signed", token: "account" }))
  })
  test("denied workspace authority never reaches native admission", async () => {
    const authorizeWorkspaceOpen = vi.fn(async () => { throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Denied") })
    const createMachineSession = vi.fn(async () => ({ id: "unwanted" }))
    const response = await ControlPlaneSessionRoutes(servicesWithWorkspaceOpenAuthorization(authorizeWorkspaceOpen), { ...signedOptions, createMachineSession }).request(request({ workspaceId: "ws_1", harness: "pi" }, true))
    expect(response.status).toBe(403)
    expect(createMachineSession).not.toHaveBeenCalled()
  })
})
