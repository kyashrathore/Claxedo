import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify } from "jose"
import { mintRelayHostToken } from "../../../workspace-relay/src/auth"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createAgentRuntime } from "../../../agent-sdk-runtime/src/runtime"
import type { AgentHarnessAdapter } from "../../../agent-sdk-runtime/src/adapter-contract"
import { createMemoryRuntimeStore } from "../../../agent-sdk-runtime/src/stores/memory"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  sessionIdle,
} from "../../../agent-sdk-runtime/src/compat-events"
import { createSessionRoutes } from "../../../workspace-runtime/src/routes/session-core"
import { remoteWorkspaceSessionAccessPolicy } from "../../../workspace-runtime/src/remote-session-authority"
import { createRelayHostAuthMiddleware } from "../../../workspace-runtime/src/workspace-host-service-auth"
import { WorkspaceCheckpointRoutes } from "../workspace/routes/checkpoints"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-two-user-runtime-"))
const previous = Object.fromEntries([
  "HOME",
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_STATE_DIR",
  "CLAXEDO_SIGNED_CLOUD_AUTH",
  "CLAXEDO_EMBEDDED_AUTH",
  "CLAXEDO_WORKSPACE_AUTHORITY_URL",
].map((key) => [key, process.env[key]]))

process.env.HOME = path.join(root, "home")
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
process.env.CLAXEDO_EMBEDDED_AUTH = "1"
delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL

await Promise.all([
  fs.mkdir(process.env.HOME, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_DATA_DIR, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_STATE_DIR, { recursive: true }),
])

const [
  { createSelfHostedApp },
  { createControlPlaneServices },
  { createSqliteCentralStore },
  { createSqliteWorkspaceAuthority },
  { openAuthorityDb },
  { controlPlaneAuthContext, betterAuthAdapter },
  { getEmbeddedAuth, EMBEDDED_AUTH_ISSUER },
  { ClaxedoDB },
] = await Promise.all([
  import("../deployments/self-hosted-node/app"),
  import("./services"),
  import("./adapters/sqlite/central-store"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"),
  import("@claxedo/server-core/platform/auth/auth"),
  import("../deployments/self-hosted-node/embedded-auth"),
  import("../platform/db"),
])

const embedded = getEmbeddedAuth()
const authorityPath = path.join(root, "authority.sqlite")
const authority = createSqliteWorkspaceAuthority({ path: authorityPath })
const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
  worktrees: [
    { sessionId: "ses_runtime_private", directory: "/workspace/private" },
    { sessionId: "ses_other", directory: "/workspace/other" },
    { directory: "/workspace/shared" },
  ],
}))
const sandboxManager = {
  list: vi.fn(async () => [{
    workspaceId: "ws_runtime_private",
    status: "ready",
    labels: {},
    persistence: { capture: "filesystem", restore: "copy-on-write" },
  }]),
} as unknown as SandboxManager
const services = createControlPlaneServices({
  projectionStore: centralStore.projectionStore,
  durableSessionLog: centralStore.durableSessionLog,
}, {
  authority,
  auth: betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: embedded.verifier }),
  sandbox: { sandboxManager },
})
const controlApp = createSelfHostedApp(services).app
const inspectAuthority = openAuthorityDb({ path: authorityPath })
const originalFetch = globalThis.fetch

type SignedAuth = Exclude<Awaited<ReturnType<typeof controlPlaneAuthContext>>, { mode: "unsigned-local" }>
type Identity = {
  actor_id: string
  actor_kind: "human" | "agent"
  actor_public_id: string
  actor_name: string
  actor_avatar_url?: string
  org_id: string
  subject: string
  token_identifier: string
}

afterAll(async () => {
  globalThis.fetch = originalFetch
  inspectAuthority().close()
  embedded.close()
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

type Stream = {
  until: (predicate: (frames: Array<{ id?: string; data: Record<string, unknown> }>) => boolean) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>
  observe: (milliseconds: number) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>
  ended: () => Promise<boolean>
  close: () => void
}

async function connect(app: Hono, token: string, lastEventId?: string): Promise<Stream> {
  const controller = new AbortController()
  const response = await app.request("http://runtime.test/event?sessionID=ses_runtime_private", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      "x-workspace-id": "ws_runtime_private",
      "x-forwarded-by": "workspace-relay",
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    signal: controller.signal,
  })
  if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`)
  const reader = response.body!.getReader()
  // Start pulling before returning the connection. Hono installs the stream
  // subscriber from the first read; publishing immediately after `connect()`
  // otherwise races that installation and can drop the first real event.
  let pendingRead = reader.read()
  const readNext = async () => {
    const next = await pendingRead
    if (!next.done) pendingRead = reader.read()
    return next
  }
  const decoder = new TextDecoder()
  let buffer = ""
  const frames: Array<{ id?: string; data: Record<string, unknown> }> = []
  const drain = () => {
    const blocks = buffer.split("\n\n")
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const lines = block.split("\n")
      const data = lines.find((line) => line.startsWith("data:"))?.slice(5).trim()
      if (!data) continue
      const parsed = JSON.parse(data)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      frames.push({
        ...(lines.find((line) => line.startsWith("id:"))?.slice(3).trim()
          ? { id: lines.find((line) => line.startsWith("id:"))!.slice(3).trim() }
          : {}),
        data: parsed,
      })
    }
  }
  return {
    async until(predicate) {
      for (let reads = 0; reads < 60; reads += 1) {
        drain()
        if (predicate(frames)) return [...frames]
        const next = await Promise.race([
          readNext(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE frame")), 1_000)),
        ])
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
      }
      drain()
      if (predicate(frames)) return [...frames]
      throw new Error(`SSE predicate was not satisfied: ${JSON.stringify(frames)}`)
    },
    async observe(milliseconds) {
      const deadline = Date.now() + milliseconds
      while (Date.now() < deadline) {
        const next = await Promise.race([
          readNext(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.min(50, deadline - Date.now()))),
        ])
        if (!next) break
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        drain()
      }
      return [...frames]
    },
    async ended() {
      return await Promise.race([
        reader.read().then((next) => next.done),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])
    },
    close: () => controller.abort(),
  }
}

function runtimeAdapter() {
  const sessions = new Map<string, { id: string; title: string; time: { created: number; updated: number } }>()
  const messages = new Map<string, Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>()
  const authors: unknown[] = []
  const adapter: AgentHarnessAdapter = {
    async listSessions() {
      return [...sessions.values()]
    },
    async getSession(id) {
      return sessions.get(id) ?? null
    },
    async createSession(_directory, title, id) {
      const session = { id: id ?? "ses_runtime_private", title: title ?? "Private runtime", time: { created: 1, updated: 1 } }
      sessions.set(session.id, session)
      return session
    },
    async updateSession(id, update) {
      const current = sessions.get(id)
      if (!current) return null
      const session = { ...current, ...(update.title ? { title: update.title } : {}), time: { ...current.time, updated: Date.now() } }
      sessions.set(id, session)
      return session
    },
    async deleteSession(id) {
      sessions.delete(id)
    },
    async getSessionConfig() {
      return { harness: { id: "pi", access: "native" }, agent: "build", variant: null }
    },
    async updateSessionConfig() {
      return { harness: { id: "pi", access: "native" }, agent: "build", variant: null }
    },
    readHarnessCapabilities() {
      return {
        harness: "pi",
        abort: false,
        reconnect: true,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: false,
      }
    },
    async *sendMessage(sessionId, input) {
      authors.push(input.author)
      const user = buildUserMessage({
        id: input.userMessageId!,
        sessionID: sessionId,
        agent: input.agent,
        model: input.model,
        ...(input.author ? { author: input.author } : {}),
      })
      const userPart = {
        id: `${input.userMessageId}-text`,
        sessionID: sessionId,
        messageID: input.userMessageId!,
        type: "text" as const,
        text: String((input.parts[0] as { text?: unknown } | undefined)?.text ?? ""),
      }
      const assistant = buildAssistantMessage({
        id: input.assistantMessageId!,
        sessionID: sessionId,
        parentID: input.userMessageId!,
        agent: input.agent,
        model: input.model,
        directory: "/workspace",
      })
      const assistantPart = {
        id: `${input.assistantMessageId}-text`,
        sessionID: sessionId,
        messageID: input.assistantMessageId!,
        type: "text" as const,
        text: "accepted",
      }
      messages.set(sessionId, [
        ...(messages.get(sessionId) ?? []),
        { info: user as unknown as Record<string, unknown>, parts: [userPart] },
        { info: assistant as unknown as Record<string, unknown>, parts: [assistantPart] },
      ])
      yield messageUpdated(user)
      yield messageUpdated(assistant)
      yield messagePartUpdated(assistantPart)
      yield sessionIdle(sessionId)
      yield { type: "finish", sessionId }
    },
    async getMessages(sessionId) {
      return messages.get(sessionId) as never ?? []
    },
    dispose() {},
  }
  return { adapter, messages, authors }
}

describe("two-user signed runtime transport acceptance", () => {
  test("binds browser identities to real RHT policy across HTTP, checkpoint projection, live/replay, reconnect, and revocation", async () => {
    const alice = await signUp("alice@runtime-acceptance.test", "Alice")
    const bob = await signUp("bob@runtime-acceptance.test", "Bob")
    const casey = await signUp("casey@runtime-acceptance.test", "Casey")
    const [aliceAuth, bobAuth, caseyAuth] = await Promise.all([
      verifiedAuth(alice.token),
      verifiedAuth(bob.token),
      verifiedAuth(casey.token),
    ])
    const [aliceIdentity, bobIdentity, caseyIdentity] = await Promise.all([
      authority.usersMe(aliceAuth),
      authority.usersMe(bobAuth),
      authority.usersMe(caseyAuth),
    ]) as Identity[]
    inspectAuthority().prepare("UPDATE users SET name = ?, image_url = ? WHERE token_identifier = ?")
      .run("Alice", "https://images.example.test/alice.png", aliceIdentity.token_identifier)
    inspectAuthority().prepare("UPDATE users SET name = ?, image_url = ? WHERE token_identifier = ?")
      .run("Bob", "https://images.example.test/bob.png", bobIdentity.token_identifier)

    await authority.createCloudWorkspace(aliceAuth, {
      workspaceId: "ws_runtime_private",
      displayName: "Runtime transport acceptance",
      repoUrl: "https://github.com/acme/runtime-private.git",
    })
    for (const identity of [bobIdentity, caseyIdentity]) {
      const granted = await signedRequest(alice.token, "/api/workspace/ws_runtime_private/shares", {
        method: "POST",
        body: JSON.stringify({ role: "editor", target: { kind: "actor", actorId: identity.actor_id } }),
      })
      expect(granted.status).toBe(200)
    }

    const key = await generateKeyPair("EdDSA", { extractable: true })
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      exportPKCS8(key.privateKey),
      exportSPKI(key.publicKey),
    ])
    const oracle = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
      authority,
      turnAuthority: authority,
      env: {
        CLAXEDO_RELAY_HOST_VERIFY_PEM: publicKeyPem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKeyPem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKeyPem,
      },
    }))
    const profile = async (auth: SignedAuth) => await authority.usersMe(auth) as Identity
    const rht = async (auth: SignedAuth, jti: string, role: "editor" | "owner" = "editor") => {
      const identity = await profile(auth)
      await authority.recordRuntimeAccessToken(auth, {
        jti,
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
        actorId: identity.actor_id,
        actorKind: identity.actor_kind,
        role,
        expiresAt: Date.now() + 60_000,
      })
      return await mintRelayHostToken({
        principalKind: "user",
        parentJti: jti,
        actorId: identity.actor_id,
        actorKind: identity.actor_kind,
        actorPublicId: identity.actor_public_id,
        actorName: identity.actor_name,
        ...(identity.actor_avatar_url ? { actorAvatarUrl: identity.actor_avatar_url } : {}),
        orgId: identity.org_id,
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
        role,
        access: "cloud",
        backing: "cloud-vm",
      }, key.privateKey, "EdDSA")
    }
    const [aliceRht, bobRht, caseyRht] = await Promise.all([
      rht(aliceAuth, "jti_runtime_alice", "owner"),
      rht(bobAuth, "jti_runtime_bob"),
      rht(caseyAuth, "jti_runtime_casey"),
    ])

    const busListeners = new Set<(event: unknown) => unknown>()
    const sessionBus = {
      publish(event: unknown) {
        for (const listener of busListeners) listener(event)
      },
      subscribe(listener: (event: unknown) => unknown) {
        busListeners.add(listener)
        return () => busListeners.delete(listener)
      },
    }
    const fixture = runtimeAdapter()
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [{ id: "pi", access: "native", create: () => fixture.adapter } as never],
    })
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "http://control.test/api/runtime-authority/session-authorize",
      fetch: async (input, init) => oracle.request(String(input), init),
    })
    const runtimeApp = new Hono()
    runtimeApp.use("*", createRelayHostAuthMiddleware({
      key: key.publicKey,
      workspaceId: "ws_runtime_private",
      hostId: "host_runtime_private",
      verifier: {
        async verify(token) {
          const verified = await jwtVerify(token, key.publicKey, {
            issuer: "workspace-relay",
            audience: "workspace-host-service",
          })
          return { subject: String(verified.payload.sub), scopes: [], claims: verified.payload as never }
        },
      },
    }))
    runtimeApp.route("/", createSessionRoutes({
      resolveAdapter: () => fixture.adapter,
      resolveRuntime: () => runtime,
      resolveDirectory: () => "/workspace",
      listSessions: () => runtime.sessions.list("/workspace"),
      createSession: (_c, directory, title, id) => runtime.sessions.create({
        id,
        directory,
        title,
        harness: { id: "pi", access: "native" },
      }),
      getSession: (_c, directory, sessionId) => runtime.sessions.get(sessionId, directory),
      getMessages: (_c, _directory, sessionId) => fixture.adapter.getMessages(sessionId, undefined),
      sessionAccessPolicy: policy,
      sessionBus,
      publishGlobal: () => {},
    }))

    const operationId = "op_runtime_private"
    const reserved = await signedRequest(alice.token, "/api/control/session-registrations/reserve", {
      method: "POST",
      body: JSON.stringify({
        operationId,
        sessionId: "ses_runtime_private",
        workspaceId: "ws_runtime_private",
        kind: "create",
        title: "Private signed runtime",
      }),
    })
    expect(reserved.status, await reserved.clone().text()).toBe(201)

    const created = await runtimeRequest(runtimeApp, aliceRht, "/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": operationId },
      body: JSON.stringify({ id: "ses_runtime_private", title: "Private signed runtime" }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    await expect(created.json()).resolves.toMatchObject({ id: "ses_runtime_private", title: "Private signed runtime" })

    const participant = await signedRequest(alice.token, "/api/control/sessions/ses_runtime_private/participants", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "ws_runtime_private",
        participantActorId: bobIdentity.actor_id,
      }),
    })
    expect(participant.status).toBe(200)

    const [aliceList, bobList, caseyList] = await Promise.all([
      runtimeRequest(runtimeApp, aliceRht, "/session"),
      runtimeRequest(runtimeApp, bobRht, "/session"),
      runtimeRequest(runtimeApp, caseyRht, "/session"),
    ])
    await expect(aliceList.json()).resolves.toMatchObject([{ id: "ses_runtime_private" }])
    await expect(bobList.json()).resolves.toMatchObject([{ id: "ses_runtime_private" }])
    await expect(caseyList.json()).resolves.toEqual([])

    expect((await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private")).status).toBe(200)
    expect((await runtimeRequest(runtimeApp, caseyRht, "/session/ses_runtime_private")).status).toBe(403)
    expect((await runtimeRequest(runtimeApp, caseyRht, "/session/ses_runtime_private/message")).status).toBe(403)

    const aliceMessage = await runtimeRequest(runtimeApp, aliceRht, "/session/ses_runtime_private/message", {
      method: "POST",
      body: JSON.stringify({ messageID: "msg_alice_runtime", parts: [{ type: "text", text: "Alice wrote this" }] }),
    })
    expect(aliceMessage.status, await aliceMessage.clone().text()).toBe(200)
    const bobPrompt = await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private/prompt_async", {
      method: "POST",
      body: JSON.stringify({ messageID: "msg_bob_runtime", parts: [{ type: "text", text: "Bob replied" }] }),
    })
    expect(bobPrompt.status).toBe(204)
    expect(await bobPrompt.text()).toBe("")
    await vi.waitFor(() => {
      expect(fixture.messages.get("ses_runtime_private")?.some((message) => message.info.id === "msg_bob_runtime")).toBe(true)
    })

    const transcript = await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private/message")
    expect(transcript.status).toBe(200)
    const transcriptRows = await transcript.json() as Array<{ info: { id: string; claxedo?: { author?: unknown } } }>
    expect(fixture.authors).toEqual([
      expect.objectContaining({ id: aliceIdentity.actor_public_id, name: "Alice" }),
      expect.objectContaining({ id: bobIdentity.actor_public_id, name: "Bob" }),
    ])
    expect(transcriptRows.filter((row) => row.info.id === "msg_alice_runtime" || row.info.id === "msg_bob_runtime")
      .map((row) => row.info.claxedo?.author)).toEqual([
      {
        id: aliceIdentity.actor_public_id,
        name: "Alice",
        avatarUrl: "https://images.example.test/alice.png",
        kind: "human",
      },
      {
        id: bobIdentity.actor_public_id,
        name: "Bob",
        avatarUrl: "https://images.example.test/bob.png",
        kind: "human",
      },
    ])
    expect(JSON.stringify(transcriptRows)).not.toContain(aliceIdentity.actor_id)
    expect(JSON.stringify(transcriptRows)).not.toContain(bobIdentity.actor_id)

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://runtime-checkpoint.test/")) return await runtimeFetch(input, init)
      return await originalFetch(input, init)
    }) as typeof globalThis.fetch
    const checkpointApp = new Hono().route("/api/workspace", WorkspaceCheckpointRoutes(services, {
      loopbackRelayUrl: "http://runtime-checkpoint.test",
    }))
    const [aliceCheckpoints, bobCheckpoints, caseyCheckpoints] = await Promise.all([
      checkpointApp.request("http://control.test/api/workspace/ws_runtime_private/checkpoints", signedInit(alice.token)),
      checkpointApp.request("http://control.test/api/workspace/ws_runtime_private/checkpoints", signedInit(bob.token)),
      checkpointApp.request("http://control.test/api/workspace/ws_runtime_private/checkpoints", signedInit(casey.token)),
    ])
    expect(aliceCheckpoints.status, await aliceCheckpoints.clone().text()).toBe(200)
    expect(bobCheckpoints.status).toBe(200)
    expect(caseyCheckpoints.status).toBe(200)
    await expect(aliceCheckpoints.json()).resolves.toMatchObject({
      worktrees: [{ sessionId: "ses_runtime_private" }, { directory: "/workspace/shared" }],
    })
    await expect(bobCheckpoints.json()).resolves.toMatchObject({
      worktrees: [{ sessionId: "ses_runtime_private" }, { directory: "/workspace/shared" }],
    })
    await expect(caseyCheckpoints.json()).resolves.toMatchObject({
      worktrees: [{ directory: "/workspace/shared" }],
    })

    const bobLive = await connect(runtimeApp, bobRht)
    const caseyLive = await runtimeApp.request("http://runtime.test/event?sessionID=ses_runtime_private", {
      headers: {
        authorization: `Bearer ${caseyRht}`,
        accept: "text/event-stream",
        "x-workspace-id": "ws_runtime_private",
        "x-forwarded-by": "workspace-relay",
      },
    })
    expect(caseyLive.status).toBe(403)
    sessionBus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/workspace",
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "live-private" },
      ts: 1,
    })
    sessionBus.publish({ type: "process.status", directory: "/workspace", configId: "public-process", status: "running" })
    const bobLiveFrames = await bobLive.until((frames) => frames.some((frame) => frame.data.info && (frame.data.info as { title?: string }).title === "live-private"))
    const bobCursor = bobLiveFrames.findLast((frame) => frame.id)?.id
    expect(bobCursor).toBeTruthy()
    bobLive.close()

    sessionBus.publish({
      type: "session.lifecycle",
      phase: "creating",
      directory: "/workspace",
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "during-reconnect-gap" },
      ts: 2,
    })
    const bobReconnect = await connect(runtimeApp, bobRht, bobCursor)
    const replay = await bobReconnect.until((frames) => frames.some((frame) => frame.data.info && (frame.data.info as { title?: string }).title === "during-reconnect-gap"))
    expect(replay.some((frame) => frame.data.sessionID === "ses_runtime_private")).toBe(true)

    const removed = await signedRequest(alice.token, "/api/control/sessions/ses_runtime_private/participants", {
      method: "DELETE",
      body: JSON.stringify({
        workspaceId: "ws_runtime_private",
        participantActorId: bobIdentity.actor_id,
      }),
    })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toMatchObject({ removed: true })
    const revoked = await signedRequest(alice.token, "/api/workspace/ws_runtime_private/shares", {
      method: "DELETE",
      body: JSON.stringify({ target: { kind: "actor", actorId: bobIdentity.actor_id } }),
    })
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 0 })
    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_runtime_bob",
      workspaceId: "ws_runtime_private",
      hostId: "host_runtime_private",
    })).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    sessionBus.publish({
      type: "session.lifecycle",
      phase: "failed",
      directory: "/workspace",
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "must-not-deliver" },
      message: "revoked",
      ts: 3,
    })
    expect(await bobReconnect.ended()).toBe(true)
    bobReconnect.close()
    expect((await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private")).status).toBe(403)
    await expect((await runtimeRequest(runtimeApp, bobRht, "/session")).json()).resolves.toEqual([])
    runtime.dispose()
  }, 30_000)
})

async function signUp(email: string, name: string) {
  const response = await controlApp.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  })
  expect(response.status).toBe(200)
  const token = response.headers.get("set-auth-token")
  expect(token).toBeTruthy()
  return { token: token! }
}

async function verifiedAuth(token: string) {
  const auth = await controlPlaneAuthContext(
    new Request("https://control.example.test", { headers: { authorization: `Bearer ${token}` } }),
    services.auth,
  )
  if (auth.mode !== "signed") throw new Error("Expected signed auth")
  return auth as SignedAuth
}

function signedInit(token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  headers.set("content-type", "application/json")
  headers.set("origin", "https://app.claxedo.test")
  return { ...init, headers }
}

function signedRequest(token: string, pathname: string, init: RequestInit = {}) {
  return controlApp.request(`https://control.example.test${pathname}`, signedInit(token, init))
}

function runtimeRequest(app: Hono, token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  headers.set("content-type", "application/json")
  headers.set("x-workspace-id", "ws_runtime_private")
  headers.set("x-forwarded-by", "workspace-relay")
  return app.request(`http://runtime.test${pathname}`, { ...init, headers })
}
