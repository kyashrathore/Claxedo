import { beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import type { ReaderSettings } from "@claxedo/agent-runtime-contract"
import { exerciseToolHeaderReads, toolHeaderTranscript } from "@claxedo/server-core/platform/auth/turn-page.conformance"
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
  return vi.fn(async () => ({ role: "owner", workspace: { backing: "cloud-vm", org_id: "org_1" } }))
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
        maxEventOrdinal: 7,
      })),
      readSessionFirstRead: vi.fn(async (_auth: unknown, input: { sessionId: string }) =>
        input.sessionId === "session-1"
          ? { session: { session_id: "session-1", title: "Signed session", created_at: 1, updated_at: 2 }, outline: { turns: [{ id: "u1", createdAt: 1 }], complete: true } }
          : undefined),
      authorizeSessionRead: vi.fn(async () => {}),
    }
    svc.authority = authority as never
    svc.projectionStore.list_session_metas = vi.fn(async () => {
      throw new Error("signed inventory must not read the unfiltered local projection")
    })
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 3)
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
    const outline = await app.request("http://127.0.0.1/sessions/session-1/outline?workspaceId=ws_1&rows=10&cols=100&reasoning=0&shell=0&edit=0", {
      headers: { Authorization: "Bearer user_1" },
    })
    const missingOutline = await app.request("http://127.0.0.1/sessions/session-2/outline?workspaceId=ws_1", {
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
    expect(outline.status).toBe(200)
    await expect(outline.json()).resolves.toEqual({
      session: { session_id: "session-1", title: "Signed session", created_at: 1, updated_at: 2 },
      outline: { turns: [{ id: "u1", createdAt: 1 }], complete: true },
    })
    expect(authority.readSessionFirstRead).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "session-1",
      workspaceId: "ws_1",
      firstPage: { rows: 10, cols: 100, reasoning: false, shell: false, edit: false },
    })
    expect(missingOutline.status).toBe(404)
    await expect(missingOutline.json()).resolves.toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
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

  test("a signed page read answers the authority's turns before the reader's cursor and names a session it cannot read", async () => {
    const svc = services()
    const page = { turns: [{ messages: [{ info: { id: "u1", role: "user" }, parts: [] }], cursor: "cursor-1" }] }
    const authority = {
      readSessionPage: vi.fn(async (_auth: unknown, input: { sessionId: string; page: { before: string } }) => {
        if (input.page.before === "foreign") throw new AgentMessagePageError(400, "Invalid message page cursor")
        return input.sessionId === "session-1" ? page : undefined
      }),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_message_page = vi.fn(() => {
      throw new Error("a signed page read must not read the central projection")
    })
    const app = ControlPlaneSessionRoutes(svc, signedOptions)
    const headers = { Authorization: "Bearer signed-token" }
    const viewport = "rows=10&cols=100&reasoning=0&shell=1&edit=0"

    const read = await app.request(`http://127.0.0.1/sessions/session-1/page?workspaceId=ws_1&${viewport}&before=cursor-2`, { headers })
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toEqual(page)
    expect(authority.readSessionPage).toHaveBeenCalledWith(expect.objectContaining({ token: "signed-token" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
      page: { rows: 10, cols: 100, reasoning: false, shell: true, edit: false, before: "cursor-2" },
    })

    authority.readSessionPage.mockClear()
    for (const query of [viewport, `${viewport}&before=`, "before=cursor-2", "rows=10&cols=100&before=cursor-2"]) {
      const refused = await app.request(`http://127.0.0.1/sessions/session-1/page?workspaceId=ws_1&${query}`, { headers })
      expect(refused.status, query).toBe(400)
      await expect(refused.json()).resolves.toMatchObject({ error: { code: "turn_page_query_error" } })
    }
    expect(authority.readSessionPage).not.toHaveBeenCalled()

    const foreign = await app.request(`http://127.0.0.1/sessions/session-1/page?workspaceId=ws_1&${viewport}&before=foreign`, { headers })
    expect(foreign.status).toBe(400)
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "message_page_error" } })

    const missing = await app.request(`http://127.0.0.1/sessions/session-2/page?workspaceId=ws_1&${viewport}&before=cursor-2`, { headers })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
    expect(svc.projectionStore.read_session_message_page).not.toHaveBeenCalled()
  })

  test("a signed part read answers the authority's whole part and names a missing part or a session it cannot read", async () => {
    const svc = services()
    const part = { id: "a1-p0", type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: {}, output: "whole", title: "a.ts", metadata: {}, time: { start: 1, end: 2 } } }
    const authority = {
      readSessionPart: vi.fn(async (_auth: unknown, input: { sessionId: string; partId: string }) =>
        input.sessionId !== "session-1" ? undefined : input.partId === "a1-p0" ? { part } : {}),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => {
      throw new Error("a signed part read must not read the central projection")
    })
    const app = ControlPlaneSessionRoutes(svc, signedOptions)
    const headers = { Authorization: "Bearer signed-token" }

    const read = await app.request("http://127.0.0.1/sessions/session-1/part?workspaceId=ws_1&messageId=a1&partId=a1-p0", { headers })
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toEqual({ part })
    expect(authority.readSessionPart).toHaveBeenCalledWith(expect.objectContaining({ token: "signed-token" }), {
      sessionId: "session-1",
      workspaceId: "ws_1",
      messageId: "a1",
      partId: "a1-p0",
    })

    for (const query of ["messageId=a1", "partId=a1-p0", "messageId=&partId=a1-p0", "messageId=a1&partId="]) {
      const unnamed = await app.request(`http://127.0.0.1/sessions/session-1/part?workspaceId=ws_1&${query}`, { headers })
      expect(unnamed.status).toBe(400)
      await expect(unnamed.json()).resolves.toMatchObject({ error: { code: "message_page_error" } })
    }

    const noPart = await app.request("http://127.0.0.1/sessions/session-1/part?workspaceId=ws_1&messageId=a1&partId=a1-p9", { headers })
    expect(noPart.status).toBe(404)
    await expect(noPart.json()).resolves.toMatchObject({ error: { code: "part_not_found" } })

    const missing = await app.request("http://127.0.0.1/sessions/session-2/part?workspaceId=ws_1&messageId=a1&partId=a1-p0", { headers })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
    expect(svc.projectionStore.read_session_messages).not.toHaveBeenCalled()
  })

  test("keeps a signed workspace page on the authority cursor chain", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({
        allowed: true,
        messages: [{ info: { id: "msg_workspace_page", role: "assistant" }, parts: [] }],
        nextCursor: "authority-next",
        maxEventOrdinal: 18,
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => {
      throw new Error("bounded workspace reads must not fall back to full projection history")
    })
    svc.projectionStore.read_session_message_page = vi.fn(() => {
      throw new Error("workspace authority cursors must not switch to the central projection")
    })
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 30)
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
      view: { scope: "workspace", sort: "updated_desc", limit: 10 },
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

  test("serves signed session-list through the same logical response shape", async () => {
    const svc = services()
    const authority = {
      listSessionPage: vi.fn(async () => [
        {
          session_id: "session-1",
          workspace_id: "ws_1",
          project_id: "proj_alpha",
          title: "Signed session",
          created_at: 1,
          updated_at: 2,
        },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "https://control.example.test/session-list?scope=workspace&workspaceId=ws_1&limit=5",
      {
        headers: { Authorization: "Bearer signed-token" },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      view: { scope: "workspace", sort: "updated_desc", limit: 5 },
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
    expect(authority.listSessionPage).toHaveBeenCalledWith(expect.objectContaining({ token: "signed-token" }), {
      workspaceId: "ws_1",
      sort: "updated_desc",
      archived: "active",
      limit: 6,
    })
  })

  test("serves a signed project's page from loopback through the same read", async () => {
    const svc = services()
    const authority = {
      listSessionPage: vi.fn(async () => [
        { session_id: "ses_b", workspace_id: "ws_b", project_id: "proj_alpha", created_at: 1, updated_at: 3 },
        { session_id: "ses_a", workspace_id: "ws_a", project_id: "proj_alpha", created_at: 1, updated_at: 2 },
      ]),
    }
    svc.authority = authority as never

    const res = await ControlPlaneSessionRoutes(svc, signedOptions).request(
      "http://127.0.0.1/session-list?scope=project&projectId=proj_alpha&limit=5",
      { headers: { Authorization: "Bearer signed-token", Origin: "http://127.0.0.1:4444" } },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { view: { scope: string }; items: Array<{ sessionRef: string; projectId?: string }> }
    expect(body.view.scope).toBe("project")
    expect(body.items.map((item) => item.sessionRef)).toEqual([
      "workspace:ws_b:session:ses_b",
      "workspace:ws_a:session:ses_a",
    ])
    expect(authority.listSessionPage).toHaveBeenCalledWith(
      expect.objectContaining({ token: "signed-token" }),
      expect.objectContaining({ projectId: "proj_alpha" }),
    )
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

  test("signed loopback workspace session messages use authority", async () => {
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
        maxEventOrdinal: 0,
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 4)

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
        maxEventOrdinal: 0,
      })),
    }
    svc.authority = authority as never
    svc.projectionStore.read_session_messages = vi.fn(() => [])
    svc.projectionStore.read_session_max_event_ordinal = vi.fn(() => 4)

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

  test("signed messages and their ordinal come from authority despite a stale projection", async () => {
    const svc = services()
    const authority = {
      readSessionMessages: vi.fn(async () => ({ messages: [{ info: { id: "msg_authority" }, parts: [] }], maxEventOrdinal: 3 })),
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
          info: { id: "msg_authority" },
          parts: [],
        },
      ],
      maxEventOrdinal: 3,
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

const turnMessage = (id: string, role: "user" | "assistant", parts: Array<Record<string, unknown>>, parentID?: string) => {
  const at = Number(id.replace(/\D/g, "")) * 10
  return {
    info: { id, sessionID: "session-1", role, time: { created: at, ...(role === "assistant" ? { completed: at + 5 } : {}) }, ...(parentID ? { parentID } : {}), ...(id === "u2" ? { summary: { title: "Second" } } : {}) },
    parts: parts.map((part, index) => ({ id: `${id}-p${index}`, sessionID: "session-1", messageID: id, ...part })),
  }
}

describe("a loopback caller without a bearer reads the local projection's first read, its pages and its parts", () => {
  const first = [turnMessage("u1", "user", [{ type: "text", text: "  first prompt " }]), turnMessage("a1", "assistant", [{ type: "text", text: "done" }], "u1")]
  const work = turnMessage("a2", "assistant", [
    { type: "text", text: "Looking." },
    { type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: {}, output: "x", title: "read", metadata: {}, time: { start: 1, end: 2 } } },
  ], "u2")
  const answer = turnMessage("a3", "assistant", [{ type: "text", text: "Answer." }], "u2")
  const second = [turnMessage("u2", "user", [{ type: "text", text: "second" }]), work, answer]
  const meta = sessionMeta({ id: "session-1", updatedAt: 30 })

  function loopback() {
    const svc = services()
    svc.projectionStore.session_meta = vi.fn(async (sessionId: string) => (sessionId === "session-1" ? meta : undefined))
    svc.projectionStore.read_session_messages = vi.fn(() => [...first, ...second])
    svc.projectionStore.read_session_message_page = vi.fn((_sessionId: string, page) =>
      "before" in page && page.before === "cursor-u2" ? { messages: first } : { messages: second, nextCursor: "cursor-u2" })
    return { svc, app: ControlPlaneSessionRoutes(svc) }
  }

  const outline = {
    complete: true,
    turns: [
      { id: "u1", createdAt: 10, user: "first prompt" },
      { id: "u2", createdAt: 20, title: "Second", user: "second" },
    ],
  }

  test("answers the session's projected row and the outline of its replay, turn by turn", async () => {
    const { app } = loopback()
    const response = await app.request("http://127.0.0.1/sessions/session-1/outline")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: meta, outline })
  })

  test("with the reader's viewport, answers the first page: the first turn whole, and the latest turn with every part, its tools as headers, and its cursor", async () => {
    const { svc, app } = loopback()
    const response = await app.request("http://127.0.0.1/sessions/session-1/outline?rows=10&cols=100&reasoning=0&shell=0&edit=0")
    expect(response.status).toBe(200)
    const { page, ...read } = await response.json()
    expect(read).toEqual({ session: meta, outline })
    expect(page.turns).toHaveLength(2)
    expect(page.turns[0]).toEqual({ messages: first })
    const latest = page.turns[1]
    expect(Object.keys(latest).sort()).toEqual(["cursor", "messages"])
    expect(latest.cursor).toBe("cursor-u2")
    expect(latest.messages.map((message: { parts: Array<{ id: string }> }) => message.parts.map((part) => part.id))).toEqual(second.map((message) => message.parts.map((part) => part.id)))
    expect(latest.messages[1].parts[1]).toMatchObject({ type: "tool", headerOnly: true, state: { output: "" } })
    expect(latest.messages[2]).toEqual(answer)
    expect(svc.projectionStore.read_session_message_page).toHaveBeenNthCalledWith(1, "session-1", { view: "latest-turn" })
    expect(svc.projectionStore.read_session_message_page).toHaveBeenNthCalledWith(2, "session-1", { view: "latest-turn", before: "cursor-u2" })
  })

  test("a page read answers the projection's turns before the reader's cursor, projected as the first page is", async () => {
    const { svc, app } = loopback()
    const response = await app.request("http://127.0.0.1/sessions/session-1/page?rows=10&cols=100&reasoning=0&shell=0&edit=0&before=cursor-u2")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ turns: [{ messages: first }] })
    expect(svc.projectionStore.read_session_message_page).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.read_session_message_page).toHaveBeenCalledWith("session-1", { view: "latest-turn", before: "cursor-u2" })
  })

  test("a page read names its cursor and its viewport, and a session the projection does not hold has no page", async () => {
    const { svc, app } = loopback()
    for (const query of ["rows=10&cols=100&reasoning=0&shell=0&edit=0", "rows=10&cols=100&reasoning=0&shell=0&edit=0&before=", "before=cursor-u2"]) {
      const refused = await app.request(`http://127.0.0.1/sessions/session-1/page?${query}`)
      expect(refused.status, query).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "turn_page_query_error" } })
    }
    const missing = await app.request("http://127.0.0.1/sessions/session-2/page?rows=10&cols=100&reasoning=0&shell=0&edit=0&before=cursor-u2")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
    expect(svc.projectionStore.read_session_message_page).not.toHaveBeenCalled()
  })

  test("a part read answers the replay's part whole, and names a missing part, a read without its part, and a session the projection does not hold", async () => {
    const { app } = loopback()
    const response = await app.request("http://127.0.0.1/sessions/session-1/part?messageId=a2&partId=a2-p1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ part: work.parts[1] })

    const wrongMessage = await app.request("http://127.0.0.1/sessions/session-1/part?messageId=a3&partId=a2-p1")
    expect(wrongMessage.status).toBe(404)
    expect(await wrongMessage.json()).toMatchObject({ error: { code: "part_not_found" } })
    const unnamed = await app.request("http://127.0.0.1/sessions/session-1/part?messageId=a2")
    expect(unnamed.status).toBe(400)
    expect(await unnamed.json()).toMatchObject({ error: { code: "message_page_error" } })
    const missing = await app.request("http://127.0.0.1/sessions/session-2/part?messageId=a2&partId=a2-p1")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
  })

  test("refuses a partial or out-of-range viewport and names a session the projection does not hold", async () => {
    const { svc, app } = loopback()
    for (const query of ["rows=10&cols=100", "rows=10&reasoning=0", "rows=10&cols=100&reasoning=0", "rows=0&cols=100&reasoning=0&shell=0&edit=0", "rows=10&cols=100&reasoning=yes&shell=0&edit=0", "rows=10&cols=2001&reasoning=1&shell=0&edit=0", "rows=10&cols=100&reasoning=0&shell=0&edit=2"]) {
      const refused = await app.request(`http://127.0.0.1/sessions/session-1/outline?${query}`)
      expect(refused.status, query).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "turn_page_query_error" } })
    }
    expect(svc.projectionStore.session_meta).not.toHaveBeenCalled()
    const missing = await app.request("http://127.0.0.1/sessions/session-2/outline?rows=10&cols=100&reasoning=0&shell=0&edit=0")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } })
  })

  test("every read sends a tool as its header, and whole only when the reader's shell or edit setting opens it", async () => {
    const transcript = toolHeaderTranscript("session-1")
    const starts = transcript.flatMap((message, index) => (message.info.role === "user" ? [index] : []))
    const turns = starts.map((start, index) => transcript.slice(start, starts[index + 1]))
    const svc = services()
    svc.projectionStore.session_meta = vi.fn(async (sessionId: string) => (sessionId === "session-1" ? meta : undefined))
    svc.projectionStore.read_session_messages = vi.fn(() => transcript as never)
    svc.projectionStore.read_session_message_page = vi.fn((_sessionId: string, page) => {
      const end = "before" in page && page.before !== undefined ? Number(page.before) : turns.length
      return { messages: (turns[end - 1] ?? []) as never, ...(end > 1 ? { nextCursor: String(end - 1) } : {}) }
    })
    const app = ControlPlaneSessionRoutes(svc)
    const settings = (reader: ReaderSettings) => `reasoning=${Number(reader.reasoning)}&shell=${Number(reader.shell)}&edit=${Number(reader.edit)}`
    const read = async (path: string) => {
      const response = await app.request(`http://127.0.0.1/sessions/session-1/${path}`)
      expect(response.status, path).toBe(200)
      return await response.json()
    }

    await exerciseToolHeaderReads({
      first: async (reader) => (await read(`outline?rows=40&cols=100&${settings(reader)}`)).page,
      page: async (reader, before) => await read(`page?rows=40&cols=100&${settings(reader)}&before=${before}`),
    }, transcript)
  })
})
