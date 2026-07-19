import { afterEach, describe, expect, test, vi } from "vitest"
import type { WhatsAppBaileysSocket } from "@claxedo/channels"
import { createApp } from "./server"
import { localOnlyAuthAdapter } from "./control-plane/auth"
import type { ControlPlaneServices } from "./control-plane/services"
import { createCentralControlApp } from "./central-runtime"
import { createControlPlaneChannels } from "./channels-control-plane"
import { ensureWorkspace } from "./workspace-store"
import type { ControlPlaneAuthConfig } from "./control-plane/auth"

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
    localExecution: { enabled: false },
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
    const { app } = createApp(services())
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
    const { app } = createApp(svc)
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

  test("repo channel ingress rejects unknown workspaces with instructions", async () => {
    const svc = services()
    const { app } = createApp(svc)
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
    const { app } = createApp(svc)
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
    const { app } = createApp(svc)
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
    const { app } = createApp(svc)
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
    const { app } = createApp(svc)
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
