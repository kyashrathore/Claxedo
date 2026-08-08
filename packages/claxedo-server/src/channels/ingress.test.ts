import { afterEach, describe, expect, test, vi } from "vitest"
import type { WhatsAppBaileysSocket } from "@claxedo/channels"
import { createSelfHostedApp } from "../deployments/self-hosted-node/app"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { createCentralControlApp } from "../central-runtime"
import { createControlPlaneChannels } from "./control-plane"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import type { ChannelRunAuditInput, ChannelRunAuditRecord } from "./run-audit"

afterEach(() => {
  vi.useRealTimers()
})

const signedAuthConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
}

function services(input: {
  signed?: boolean
  authorizeChannelProject?: (args: {
    channel: string
    externalUserId: string
    threadKey: string
    projectId: string
    action: string
  }) => Promise<{ ok: true; role: "viewer" | "editor" | "admin" | "owner"; orgId: string } | { ok: false }>
} = {}): ControlPlaneServices {
  const putCredential = vi.fn(async (input: Parameters<ControlPlaneServices["credentials"]["putCredential"]>[0]) => ({
    id: input.provider_id,
    provider_id: input.provider_id,
    kind: input.kind,
    source: input.source,
    label: input.label ?? null,
    account_id: input.account_id ?? null,
    secure_ref: "local:whatsapp-state",
    status: "available" as const,
    expires_at: input.expires_at ?? null,
    last_validated_at: 1,
    last_error: null,
    created_at: 1,
    updated_at: 1,
  }))
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
      record_channel_run_audit: vi.fn(async () => {}),
      channel_run_audit: vi.fn(async () => undefined),
      channel_run_audits: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
    auth: input.signed
      ? { config: signedAuthConfig, verifier: vi.fn() }
      : localOnlyAuthAdapter(),
    credentials: {
      listCredentials: vi.fn(async () => []),
      getCredentialByProvider: vi.fn(async () => undefined),
      resolveCredentialSecret: vi.fn(async () => null),
      putCredential,
      deleteCredential: vi.fn(async () => true),
      deleteCredentialsByProvider: vi.fn(async () => 0),
      updateCredentialStatus: vi.fn(async () => {}),
      syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
    },
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    // SELF-HOST services. Every test in this file exercises `/api/channels/fake`,
    // which only the self-host composition mounts: `server.ts` passes
    // `includeFake: true`, while the hosted composition (`hosted-node.ts`) passes
    // `includeFake: false` and `requireLoopbackForFake: false` — so under hosted
    // the route does not exist and the loopback gate asserted below is absent.
    //
    // This said `enabled: false` from the history reset (00a533c2f), which was
    // inert until 25b8025c4 made `createSelfHostedApp` reject non-self-host services as its
    // first statement. That mismatch, not any channels behavior, is what broke
    // these tests; the flag was always describing the wrong composition.
    localExecution: { enabled: true },
    ...(input.signed
      ? {
          authority: {
            authorizeChannelProject: input.authorizeChannelProject ?? vi.fn(async () => ({ ok: true, role: "editor", orgId: "org_1" })),
            authorizeChannelWorkspace: vi.fn(async () => {}),
          } as never,
        }
      : {}),
  }
}

async function registeredRepoWorkspace(input: {
  workspaceId: string
  projectId: string
  owner: string
  name: string
}) {
  await ensureWorkspace({
    workspaceId: input.workspaceId,
    project_id: input.projectId,
    directory: "/workspace",
    kind: "cloud",
    repo_url: `https://github.com/${input.owner}/${input.name}.git`,
  })
}

describe("channels ingress", () => {
  test("keeps fake channel ingress loopback-only until signed channel auth lands", async () => {
    const { app } = createSelfHostedApp(services())
    const blocked = await app.request("https://control.example.test/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", idempotencyKey: "blocked" }),
    })

    expect(blocked.status).toBe(401)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "channels_fake_loopback_required" },
    })
  })

  test("fake channel ingress can drive the central runtime locally", async () => {
    const svc = services()
    const { app } = createSelfHostedApp(svc)
    const res = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        externalUserId: "owner",
        threadKey: "telegram:test:chat:thread",
        idempotencyKey: "delivery-1",
        text: "hello",
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      chunks: expect.arrayContaining([
        expect.objectContaining({ kind: "status", phase: "creating" }),
        expect.objectContaining({ kind: "text", text: expect.stringContaining("hello") }),
        expect.objectContaining({ kind: "text", final: true }),
      ]),
    })
    expect(JSON.stringify(body)).toContain("Trust: external-untrusted")
    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      tags: [
        "source-channel:telegram",
        "source-thread:telegram:test:chat:thread",
      ],
    }))
    expect(svc.telemetry.capture).toHaveBeenCalledWith("channel:telegram:owner", "channel.session.created", {
      sessionId: expect.any(String),
      channel: "telegram",
      externalUserId: "owner",
      threadKey: "telegram:test:chat:thread",
      workspaceId: null,
      cost: null,
    })
    expect(svc.projectionStore.record_channel_run_audit).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      channel: "telegram",
      externalUserId: "owner",
      threadKey: "telegram:test:chat:thread",
      workspaceId: null,
      cost: null,
    })
  })

  test("/new durably clears the active channel session without erasing audit history", async () => {
    const svc = services()
    const active = new Map<string, string>()
    const audits: ChannelRunAuditRecord[] = []
    Object.assign(svc.projectionStore, {
      record_channel_run_audit: vi.fn(async (input: ChannelRunAuditInput) => {
        audits.push({
          sessionId: input.sessionId,
          channel: input.channel,
          externalUserId: input.externalUserId,
          threadKey: input.threadKey,
          workspaceId: input.workspaceId ?? null,
          cost: input.cost ?? null,
          createdAt: input.createdAt ?? Date.now(),
        })
        active.set(input.threadKey, input.sessionId)
      }),
      channel_run_audit: vi.fn(async (input: { sessionId: string }) =>
        audits.find((audit) => audit.sessionId === input.sessionId)),
      channel_run_audits: vi.fn(async () => [...audits].reverse()),
      channel_thread_session: vi.fn(async (input: { threadKey: string }) => active.get(input.threadKey)),
      clear_channel_thread_session: vi.fn(async (input: { threadKey: string; sessionId?: string }) => {
        if (!input.sessionId || active.get(input.threadKey) === input.sessionId) active.delete(input.threadKey)
      }),
    })
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      includeFake: true,
    })
    const threadKey = "telegram:test:reset:thread"
    const send = async (
      text: string,
      idempotencyKey: string,
      intent: { kind: "message" } | { kind: "new_session" } = { kind: "message" },
    ) => {
      const chunks: unknown[] = []
      await channels.core.handleInbound({
        channel: "telegram",
        externalUserId: "owner",
        threadKey,
        idempotencyKey,
        text,
        intent,
        trustedSource: true,
        raw: {},
      }, {
        reply(chunk) {
          chunks.push(chunk)
        },
      })
      return chunks
    }

    await send("first message", "reset-delivery-1")
    const firstSessionId = active.get(threadKey)
    expect(firstSessionId).toBeTruthy()

    await expect(send("/new", "reset-delivery-new", { kind: "new_session" })).resolves.toEqual([{
      kind: "text",
      text: "Started a fresh session. Your next message begins a new conversation.",
      final: true,
    }])
    expect(active.has(threadKey)).toBe(false)
    expect(audits.map((audit) => audit.sessionId)).toEqual([firstSessionId])

    await send("second message", "reset-delivery-2")
    expect(active.get(threadKey)).not.toBe(firstSessionId)
    expect(audits).toHaveLength(2)
    expect(audits.map((audit) => audit.sessionId)).toContain(firstSessionId)
  })

  test("/new prevents a late session creation from resurrecting the active binding", async () => {
    const svc = services()
    const active = new Map<string, string>()
    const audits: ChannelRunAuditRecord[] = []
    const clearChannelThreadSession = vi.fn(async (input: { threadKey: string; sessionId?: string }) => {
      if (input.sessionId) throw new Error("invalidated generations must not require conditional cleanup")
      active.delete(input.threadKey)
    })
    Object.assign(svc.projectionStore, {
      record_channel_run_audit: vi.fn(async (input: ChannelRunAuditInput) => {
        audits.push({
          sessionId: input.sessionId,
          channel: input.channel,
          externalUserId: input.externalUserId,
          threadKey: input.threadKey,
          workspaceId: input.workspaceId ?? null,
          cost: input.cost ?? null,
          createdAt: input.createdAt ?? Date.now(),
        })
        active.set(input.threadKey, input.sessionId)
      }),
      channel_run_audit: vi.fn(async (input: { sessionId: string }) =>
        audits.find((audit) => audit.sessionId === input.sessionId)),
      channel_run_audits: vi.fn(async () => [...audits].reverse()),
      channel_thread_session: vi.fn(async (input: { threadKey: string }) => active.get(input.threadKey)),
      clear_channel_thread_session: clearChannelThreadSession,
    })
    let completeCreate: ((session: { id: string }) => void) | undefined
    const createHybridSession = vi.fn()
      .mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => {
        completeCreate = resolve
      }))
      .mockResolvedValueOnce({ id: "session-after-race" })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: {
        createHybridSession,
        eventHub: { subscribeGlobal: () => () => {} },
        routes: {
          fetch: vi.fn(async () => Response.json({
            id: "message-race",
            sessionID: "session-after-race",
            role: "assistant",
          })),
        },
      } as never,
      includeFake: true,
    })
    const threadKey = "telegram:test:reset-race:thread"
    const send = async (
      text: string,
      idempotencyKey: string,
      intent: { kind: "message" } | { kind: "new_session" } = { kind: "message" },
    ) => {
      const chunks: unknown[] = []
      await channels.core.handleInbound({
        channel: "telegram",
        externalUserId: "owner",
        threadKey,
        idempotencyKey,
        text,
        intent,
        trustedSource: true,
        raw: {},
      }, {
        reply(chunk) {
          chunks.push(chunk)
        },
      })
      return chunks
    }

    const firstSend = send("slow message", "race-delivery-1")
    await vi.waitFor(() => expect(createHybridSession).toHaveBeenCalledTimes(1))
    await send("/new", "race-delivery-new", { kind: "new_session" })
    const nextSend = send("after reset", "race-delivery-2")
    await Promise.resolve()
    expect(createHybridSession).toHaveBeenCalledTimes(1)
    completeCreate?.({ id: "session-late" })
    await Promise.all([firstSend, nextSend])

    expect(createHybridSession).toHaveBeenCalledTimes(2)
    expect(active.get(threadKey)).toBe("session-after-race")
    expect(audits.map((audit) => audit.sessionId)).toEqual(["session-after-race"])
    expect(clearChannelThreadSession).toHaveBeenCalledTimes(1)
    expect(clearChannelThreadSession).toHaveBeenCalledWith({ threadKey })
  })

  test("/new lets the next send proceed when an invalidated pending creation rejects", async () => {
    const svc = services()
    const active = new Map<string, string>()
    Object.assign(svc.projectionStore, {
      record_channel_run_audit: vi.fn(async (input: ChannelRunAuditInput) => {
        active.set(input.threadKey, input.sessionId)
      }),
      channel_run_audit: vi.fn(async () => undefined),
      channel_run_audits: vi.fn(async () => []),
      channel_thread_session: vi.fn(async (input: { threadKey: string }) => active.get(input.threadKey)),
      clear_channel_thread_session: vi.fn(async (input: { threadKey: string }) => {
        active.delete(input.threadKey)
      }),
    })
    let rejectCreate: ((error: Error) => void) | undefined
    const createHybridSession = vi.fn()
      .mockImplementationOnce(() => new Promise<{ id: string }>((_resolve, reject) => {
        rejectCreate = reject
      }))
      .mockResolvedValueOnce({ id: "session-after-rejection" })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: {
        createHybridSession,
        eventHub: { subscribeGlobal: () => () => {} },
        routes: {
          fetch: vi.fn(async () => Response.json({
            id: "message-after-rejection",
            sessionID: "session-after-rejection",
            role: "assistant",
          })),
        },
      } as never,
      includeFake: true,
    })
    const threadKey = "telegram:test:reset-rejection:thread"
    const send = (text: string, idempotencyKey: string, intent: { kind: "message" } | { kind: "new_session" }) =>
      channels.core.handleInbound({
        channel: "telegram",
        externalUserId: "owner",
        threadKey,
        idempotencyKey,
        text,
        intent,
        trustedSource: true,
        raw: {},
      }, { reply() {} })

    const firstSend = send("slow failure", "rejection-delivery-1", { kind: "message" })
    await vi.waitFor(() => expect(createHybridSession).toHaveBeenCalledTimes(1))
    await send("/new", "rejection-delivery-new", { kind: "new_session" })
    const nextSend = send("after failure", "rejection-delivery-2", { kind: "message" })
    const createFailure = new Error("session creation failed")
    const rejected = expect(firstSend).rejects.toBe(createFailure)
    rejectCreate?.(createFailure)

    await Promise.all([rejected, nextSend])
    expect(createHybridSession).toHaveBeenCalledTimes(2)
    expect(active.get(threadKey)).toBe("session-after-rejection")
  })

  test("active channel binding storage failures reject instead of creating or resetting sessions", async () => {
    const svc = services()
    const bindingFailure = new Error("binding storage unavailable")
    svc.projectionStore.channel_thread_session = vi.fn(async () => {
      throw bindingFailure
    })
    svc.projectionStore.clear_channel_thread_session = vi.fn(async () => {
      throw bindingFailure
    })
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      includeFake: true,
    })
    const envelope = {
      channel: "telegram" as const,
      externalUserId: "owner",
      threadKey: "telegram:test:binding-failure:thread",
      idempotencyKey: "binding-failure-1",
      text: "hello",
      intent: { kind: "message" as const },
      trustedSource: true,
      raw: {},
    }

    await expect(channels.core.handleInbound(envelope, { reply: () => {} })).rejects.toBe(bindingFailure)
    expect(svc.projectionStore.record_channel_run_audit).not.toHaveBeenCalled()

    svc.projectionStore.channel_thread_session = vi.fn(async () => undefined)
    await channels.core.handleInbound({ ...envelope, idempotencyKey: "binding-failure-2" }, { reply: () => {} })
    await expect(channels.core.handleInbound({
      ...envelope,
      idempotencyKey: "binding-failure-new",
      text: "/new",
      intent: { kind: "new_session" as const },
    }, { reply: () => {} })).rejects.toBe(bindingFailure)
    await expect(channels.core.handleInbound({
      ...envelope,
      idempotencyKey: "binding-failure-after-reset",
    }, { reply: () => {} })).rejects.toBe(bindingFailure)
  })

  test("repo channel ingress rejects unknown workspaces with instructions", async () => {
    const svc = services()
    const { app } = createSelfHostedApp(svc)
    const res = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:test:issue:thread",
        idempotencyKey: "unknown-repo-1",
        text: "@claxedo fix this",
        repo: { owner: "claxedo-test-missing-owner", name: "missing-repo" },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      chunks: [{
        kind: "text",
        text: expect.stringContaining("No registered workspace for claxedo-test-missing-owner/missing-repo."),
        final: true,
      }],
    })
    expect(svc.projectionStore.put_session_meta).not.toHaveBeenCalled()
    expect(svc.projectionStore.record_channel_run_audit).not.toHaveBeenCalled()
    expect(svc.telemetry.capture).not.toHaveBeenCalled()
  })

  test("signed channel ingress rejects linked users without project role before creating a session", async () => {
    const authorizeChannelProject = vi.fn(async () => ({ ok: false as const }))
    const svc = services({ signed: true, authorizeChannelProject })
    await registeredRepoWorkspace({
      workspaceId: "ws_channel_denied",
      projectId: "project_channel_denied",
      owner: "claxedo-auth",
      name: "denied",
    })
    const { app } = createSelfHostedApp(svc)
    const res = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:install-auth:claxedo-auth/denied:issue-1",
        idempotencyKey: "denied-1",
        text: "@claxedo fix this",
        repo: { owner: "claxedo-auth", name: "denied" },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      chunks: [{
        kind: "text",
        text: "Your linked channel account does not have access to this project.",
        final: true,
      }],
    })
    expect(authorizeChannelProject).toHaveBeenCalledWith({
      channel: "github",
      externalUserId: "octocat",
      threadKey: "github:install-auth:claxedo-auth/denied:issue-1",
      projectId: "project_channel_denied",
      action: "write",
    })
    expect(svc.projectionStore.put_session_meta).not.toHaveBeenCalled()
    expect(svc.projectionStore.record_channel_run_audit).not.toHaveBeenCalled()
  })

  test("signed channel ingress authorizes repo sessions through project roles", async () => {
    const authorizeChannelProject = vi.fn(async () => ({ ok: true as const, role: "editor" as const, orgId: "org_1" }))
    const svc = services({ signed: true, authorizeChannelProject })
    await registeredRepoWorkspace({
      workspaceId: "ws_channel_allowed",
      projectId: "project_channel_allowed",
      owner: "claxedo-auth",
      name: "allowed",
    })
    const { app } = createSelfHostedApp(svc)
    const res = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:install-auth:claxedo-auth/allowed:issue-1",
        idempotencyKey: "allowed-1",
        text: "@claxedo fix this",
        repo: { owner: "claxedo-auth", name: "allowed" },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      chunks: expect.arrayContaining([
        expect.objectContaining({ kind: "status", phase: "creating" }),
        expect.objectContaining({ kind: "text", final: true }),
      ]),
    })
    expect(authorizeChannelProject).toHaveBeenCalledWith({
      channel: "github",
      externalUserId: "octocat",
      threadKey: "github:install-auth:claxedo-auth/allowed:issue-1",
      projectId: "project_channel_allowed",
      action: "write",
    })
    expect(svc.projectionStore.put_session_meta).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      workspaceID: "ws_channel_allowed",
    }))
    expect(svc.projectionStore.record_channel_run_audit).toHaveBeenCalledWith(expect.objectContaining({
      channel: "github",
      externalUserId: "octocat",
      workspaceId: "ws_channel_allowed",
    }))
  })

  test("signed channel continuations reauthorize the actor against the existing session project", async () => {
    const authorizeChannelProject = vi.fn(async (args: { externalUserId: string }) => args.externalUserId === "octocat"
      ? { ok: true as const, role: "editor" as const, orgId: "org_1" }
      : { ok: false as const })
    const svc = services({ signed: true, authorizeChannelProject })
    await registeredRepoWorkspace({
      workspaceId: "ws_channel_continue",
      projectId: "project_channel_continue",
      owner: "claxedo-auth",
      name: "continue",
    })
    const { app } = createSelfHostedApp(svc)
    const first = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:install-auth:claxedo-auth/continue:issue-1",
        idempotencyKey: "continue-1",
        text: "@claxedo start",
        repo: { owner: "claxedo-auth", name: "continue" },
      }),
    })
    expect(first.status).toBe(200)

    const second = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "intruder",
        threadKey: "github:install-auth:claxedo-auth/continue:issue-1",
        idempotencyKey: "continue-2",
        text: "@claxedo continue",
      }),
    })

    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      chunks: [{
        kind: "text",
        text: "Your linked channel account does not have access to this project.",
        final: true,
      }],
    })
    expect(authorizeChannelProject).toHaveBeenLastCalledWith({
      channel: "github",
      externalUserId: "intruder",
      threadKey: "github:install-auth:claxedo-auth/continue:issue-1",
      projectId: "project_channel_continue",
      action: "write",
    })
  })

  test("signed channel continuations ignore spoofed repo targets and use the existing session workspace", async () => {
    const authorizeChannelProject = vi.fn(async () => ({ ok: true as const, role: "editor" as const, orgId: "org_1" }))
    const svc = services({ signed: true, authorizeChannelProject })
    await registeredRepoWorkspace({
      workspaceId: "ws_channel_original",
      projectId: "project_channel_original",
      owner: "claxedo-auth",
      name: "original",
    })
    await registeredRepoWorkspace({
      workspaceId: "ws_channel_spoofed",
      projectId: "project_channel_spoofed",
      owner: "claxedo-auth",
      name: "spoofed",
    })
    const { app } = createSelfHostedApp(svc)
    const first = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:install-auth:claxedo-auth/original:issue-1",
        idempotencyKey: "spoofed-1",
        text: "@claxedo start",
        repo: { owner: "claxedo-auth", name: "original" },
      }),
    })
    expect(first.status).toBe(200)

    const second = await app.request("http://127.0.0.1/api/channels/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "github",
        externalUserId: "octocat",
        threadKey: "github:install-auth:claxedo-auth/original:issue-1",
        idempotencyKey: "spoofed-2",
        text: "@claxedo continue",
        repo: { owner: "claxedo-auth", name: "spoofed" },
      }),
    })

    expect(second.status).toBe(200)
    expect(authorizeChannelProject).toHaveBeenLastCalledWith({
      channel: "github",
      externalUserId: "octocat",
      threadKey: "github:install-auth:claxedo-auth/original:issue-1",
      projectId: "project_channel_original",
      action: "write",
    })
  })

  test("personal WhatsApp ingress starts an injected Baileys socket with credential-backed auth state", async () => {
    vi.useFakeTimers()
    const svc = services()
    vi.mocked(svc.credentials.resolveCredentialSecret!).mockResolvedValue(JSON.stringify({ loaded: true }))
    const startedWith: unknown[] = []
    const authHandlers: ((state: unknown) => void)[] = []
    const socket = {
      start(input) {
        startedWith.push(input)
      },
      onMessage() {},
      onAuthState(handler) {
        authHandlers.push(handler)
      },
      sendMessage() {},
    } satisfies WhatsAppBaileysSocket
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      env: {
        CLAXEDO_CHANNEL_WHATSAPP_ENABLED: "true",
        CLAXEDO_CHANNEL_WHATSAPP_MODE: "personal",
        CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_SECRET_ID: "wa-state",
        CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_DEVICE_ID: "owner-phone",
      },
      whatsappBaileysSocket: socket,
    })

    const res = await channels.ingress.request("http://channels.test/whatsapp", { method: "POST" })
    authHandlers[0]?.({ version: 2 })
    await vi.advanceTimersByTimeAsync(1000)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      channel: "whatsapp",
      transport: "baileys",
      running: true,
    })
    expect(svc.credentials.resolveCredentialSecret).toHaveBeenCalledWith("wa-state")
    expect(startedWith).toEqual([{ authState: { loaded: true } }])
    expect(svc.credentials.putCredential).toHaveBeenCalledWith({
      provider_id: "wa-state",
      kind: "subscription_session",
      source: "managed",
      label: "WhatsApp Baileys auth state",
      secret: JSON.stringify({ version: 2 }),
    })
  })

  test("delivers one idempotent proactive notification to the owner's latest bound channel thread", async () => {
    const svc = services({ signed: true })
    const claims = new Set<string>()
    Object.assign(svc.projectionStore, {
      channel_run_audits: vi.fn(async () => [{
        sessionId: "session-owner",
        channel: "slack",
        externalUserId: "U-OWNER-NOTIFY",
        threadKey: "slack:team:channel:thread",
        workspaceId: null,
        cost: null,
        createdAt: 10,
      }]),
      claim_channel_delivery: vi.fn(async (input: { channel: string; idempotencyKey: string }) => {
        const key = `${input.channel}:${input.idempotencyKey}`
        if (claims.has(key)) return { ok: true, duplicate: true }
        claims.add(key)
        return { ok: true, duplicate: false }
      }),
      release_channel_delivery: vi.fn(async (input: { channel: string; idempotencyKey: string }) => {
        claims.delete(`${input.channel}:${input.idempotencyKey}`)
      }),
    })
    const posts: string[] = []
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      env: { CLAXEDO_CHANNEL_SLACK_ENABLED: "true" },
      chatBot: {
        webhooks: {},
        thread: () => ({ post: async (text) => posts.push(String(text)) }),
      },
    })
    await channels.bindings.put({
      channel: "slack",
      externalUserId: "U-OWNER-NOTIFY",
      accountId: "owner-notify",
      status: "bound",
      boundAt: 1,
    })

    await expect(channels.notifyOwner({
      ownerUserId: "owner-notify",
      idempotencyKey: "master-tool-1",
      text: "Stream is ready",
      now: 20,
    })).resolves.toMatchObject({ channel: "slack", duplicate: false })
    await expect(channels.notifyOwner({
      ownerUserId: "owner-notify",
      idempotencyKey: "master-tool-1",
      text: "Stream is ready",
      now: 20,
    })).resolves.toMatchObject({ channel: "slack", duplicate: true })
    expect(posts).toEqual(["Stream is ready"])
  })

  test("never treats global allow-list seeds as notification recipients for another owner", async () => {
    const svc = services({ signed: true })
    Object.assign(svc.projectionStore, {
      channel_run_audits: vi.fn(async (input: { externalUserId?: string }) => [{
        sessionId: `session-${input.externalUserId}`,
        channel: "slack",
        externalUserId: input.externalUserId ?? "",
        threadKey: `slack:team:channel:${input.externalUserId}`,
        workspaceId: null,
        cost: null,
        createdAt: input.externalUserId === "U-OWNER-NOTIFY" ? 10 : 20,
      }]),
      claim_channel_delivery: vi.fn(async () => ({ ok: true, duplicate: false })),
      release_channel_delivery: vi.fn(async () => {}),
    })
    const posts: Array<{ threadKey: string; text: string }> = []
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      env: {
        CLAXEDO_CHANNEL_SLACK_ENABLED: "true",
        CLAXEDO_CHANNEL_ALLOW_FROM: "slack:U-OWNER-NOTIFY,slack:U-OTHER-ALLOWLISTED",
      },
      chatBot: {
        webhooks: {},
        thread: (threadKey) => ({ post: async (text) => posts.push({ threadKey, text: String(text) }) }),
      },
    })
    await channels.bindings.put({
      channel: "slack",
      externalUserId: "U-OWNER-NOTIFY",
      accountId: "owner-notify",
      status: "bound",
      boundAt: 1,
    })
    await channels.bindings.put({
      channel: "slack",
      externalUserId: "U-OTHER-ALLOWLISTED",
      accountId: "other-owner",
      status: "bound",
      boundAt: 1,
    })

    await expect(channels.notifyOwner({
      ownerUserId: "owner-notify",
      idempotencyKey: "owner-only",
      text: "Private owner update",
      now: 20,
    })).resolves.toMatchObject({ threadKey: "slack:team:channel:U-OWNER-NOTIFY" })
    expect(posts).toEqual([{ threadKey: "slack:team:channel:U-OWNER-NOTIFY", text: "Private owner update" }])
    expect(svc.projectionStore.channel_run_audits).toHaveBeenCalledTimes(1)
    expect(svc.projectionStore.channel_run_audits).toHaveBeenCalledWith({
      channel: "slack",
      externalUserId: "U-OWNER-NOTIFY",
    })
  })
})

/**
 * The sender names the repo ("repo:owner/name" in their own message), so a named
 * repo that resolves to no workspace used to return `{ ok: true }` from
 * `authorizeInbound` — skipping the project authorization entirely and falling
 * back to whatever the thread already had. A sender could name a nonexistent
 * repo to dodge the check. It now fails closed.
 *
 * These drive `channels.core.handleInbound` directly rather than `createSelfHostedApp`,
 * which currently throws for these services (see the `localExecution` guard at
 * server.ts:452 — a pre-existing breakage tracked separately). `trustedSource`
 * bypasses the DM/group access gate but NOT `authorize`, which is the seam under
 * test here.
 */
describe("channel repo authorization fails closed", () => {
  async function send(input: {
    channels: ReturnType<typeof createControlPlaneChannels>
    repo?: { owner: string; name: string }
    threadKey?: string
    idempotencyKey?: string
  }) {
    const chunks: unknown[] = []
    await input.channels.core.handleInbound({
      channel: "github",
      externalUserId: "octocat",
      threadKey: input.threadKey ?? "github:test:failclosed:thread",
      idempotencyKey: input.idempotencyKey ?? `failclosed-${Math.random()}`,
      text: "@claxedo fix this",
      ...(input.repo ? { repo: input.repo } : {}),
      trustedSource: true,
      raw: {},
    }, {
      reply(chunk) {
        chunks.push(chunk)
      },
    })
    return chunks
  }

  function harness(input: { signed?: boolean } = {}) {
    const svc = services({ signed: input.signed === true })
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    return {
      svc,
      channels: createControlPlaneChannels({
        services: svc,
        runtime: centralControl.runtime,
        includeFake: true,
      }),
    }
  }

  test("a sender-named repo resolving to no workspace is denied, not waved through", async () => {
    const { svc, channels } = harness({ signed: true })

    const chunks = await send({
      channels,
      repo: { owner: "claxedo-failclosed", name: "never-registered" },
    })

    expect(chunks).toEqual([{
      kind: "text",
      text: "No registered workspace for claxedo-failclosed/never-registered. Open or register it in Claxedo, then retry.",
      final: true,
    }])
    // Denied BEFORE any session work — the whole point of failing closed here.
    expect(svc.projectionStore.record_channel_run_audit).not.toHaveBeenCalled()
    expect(svc.projectionStore.put_session_meta).not.toHaveBeenCalled()
  })

  test("the deny does not consult the authority at all", async () => {
    // There is no workspace to authorize against, so asking would be
    // meaningless; the refusal is structural.
    const authorizeChannelProject = vi.fn(async () => ({ ok: true as const, role: "editor" as const, orgId: "org_1" }))
    const svc = services({ signed: true, authorizeChannelProject })
    const centralControl = createCentralControlApp(svc, { authConfig: svc.auth.config })
    const channels = createControlPlaneChannels({
      services: svc,
      runtime: centralControl.runtime,
      includeFake: true,
    })

    await send({ channels, repo: { owner: "claxedo-failclosed", name: "absent" } })

    expect(authorizeChannelProject).not.toHaveBeenCalled()
  })

  test("fails closed in unsigned mode too, where there is no account auth behind it", async () => {
    // Unsigned/self-host has no project authorization to fall back on, so
    // letting an unresolvable repo through would be strictly worse here.
    const { channels } = harness()

    const chunks = await send({
      channels,
      repo: { owner: "claxedo-failclosed", name: "unsigned-absent" },
    })

    expect(chunks).toEqual([{
      kind: "text",
      text: "No registered workspace for claxedo-failclosed/unsigned-absent. Open or register it in Claxedo, then retry.",
      final: true,
    }])
  })

  test("a registered repo still runs a turn", async () => {
    // The positive case: failing closed must not have closed the door on the
    // repos that DO resolve.
    const { svc, channels } = harness({ signed: true })
    await registeredRepoWorkspace({
      workspaceId: "ws_failclosed_ok",
      projectId: "project_failclosed_ok",
      owner: "claxedo-failclosed",
      name: "registered",
    })

    const chunks = await send({
      channels,
      repo: { owner: "claxedo-failclosed", name: "registered" },
      threadKey: "github:test:failclosed:ok",
    })

    expect(chunks).not.toContainEqual(expect.objectContaining({
      text: expect.stringContaining("No registered workspace"),
    }))
    expect(svc.projectionStore.record_channel_run_audit).toHaveBeenCalled()
  })

  test("a message with no repo target runs a turn in unsigned mode", async () => {
    // Only a NAMED repo triggers the new check; an ordinary message still
    // resolves through the thread's own binding.
    const { svc, channels } = harness()

    const chunks = await send({ channels, threadKey: "github:test:failclosed:norepo" })

    expect(chunks).not.toContainEqual(expect.objectContaining({
      text: expect.stringContaining("No registered workspace"),
    }))
    expect(svc.projectionStore.record_channel_run_audit).toHaveBeenCalled()
  })

  test("a no-repo message in signed mode keeps its own distinct refusal", async () => {
    // Signed mode with neither a named repo nor an existing session already
    // refuses, with different wording and for a different reason. The new
    // fail-closed branch must not swallow that case or restate it — the two
    // messages tell the sender to do different things.
    const { channels } = harness({ signed: true })

    const chunks = await send({ channels, threadKey: "github:test:failclosed:signed-norepo" })

    expect(chunks).toEqual([{
      kind: "text",
      text: "Mention a registered repo or continue an authorized channel session.",
      final: true,
    }])
  })
})
