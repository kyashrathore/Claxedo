import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "../../../workspace-relay/src/auth"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createWorkspaceRuntimeApp } from "../../../workspace-runtime/src/server"
import { relayWorkspaceRuntimeExposure } from "../../../workspace-runtime/src/exposure"
import { remoteWorkspaceSessionAccessPolicy } from "../../../workspace-runtime/src/remote-session-authority"
import { loopbackMachineLoginPolicy } from "../../../workspace-runtime/src/testing"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { WorkspaceCheckpointRoutes } from "../workspace/routes/checkpoints"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"
import { fetchUrl } from "../test-support/fetch-calls"
import { miniflareControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { createD1CoreAuthority } from "./adapters/d1/core-authority"
import { PrivateSessionRegistrationRoutes } from "../routes/private-session-registration"
import { SessionPeopleControlRoutes } from "../session/routes/session-people-routes"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { AuthenticationError, type ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneServices } from "./services"
import { removeTestDataDir } from "../test-support/test-data-dir"
import { inviteOrgMember } from "../test-support/invite-org-member"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-two-user-runtime-"))
const database = await miniflareControlPlaneDatabase()
const authority = createD1CoreAuthority(database.database, {
  deploymentId: "deployment-test",
  product: { kind: "claxedo-hosted" },
})
const principals = new Map<string, ControlPlanePrincipal>()
const authentication = {
  descriptor: testRequestAuthenticationAdapter().descriptor,
  async authenticate(request: Request) {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
    const principal = token ? principals.get(token) : undefined
    if (!principal) throw new AuthenticationError(401, "invalid_credentials", "Unknown test identity")
    return principal
  },
}
const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
  Response.json({
    worktrees: [
      { sessionId: "ses_runtime_private", directory: "/workspace/private" },
      { sessionId: "ses_unregistered", directory: "/workspace/other" },
      { directory: "/workspace/shared" },
    ],
  }),
)
const sandboxManager = {
  list: vi.fn(async () => [
    {
      workspaceId: "ws_runtime_private",
      status: "ready",
      labels: {},
      persistence: { capture: "filesystem", restore: "copy-on-write" },
    },
  ]),
} as unknown as SandboxManager
const services = {
  authority,
  sandbox: { sandboxManager },
  relay: {},
  auth: { config: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" } },
  telemetry: { capture: vi.fn() },
} as unknown as ControlPlaneServices
const controlApp = new Hono()
  .route("/api/control/session-registrations", PrivateSessionRegistrationRoutes({ authority, authentication }))
  .route("/api/control", SessionPeopleControlRoutes(services, { authentication }))
const originalFetch = globalThis.fetch

afterAll(async () => {
  globalThis.fetch = originalFetch
  await database.dispose()
  removeTestDataDir(root)
})

type Stream = {
  until: (
    predicate: (frames: Array<{ id?: string; data: Record<string, unknown> }>) => boolean,
  ) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>
  ended: () => Promise<boolean>
  close: () => void
}

async function connect(
  app: Hono,
  token: string,
  lastEventId?: string,
  scope: "session" | "workspace" = "session",
): Promise<Stream> {
  const controller = new AbortController()
  onTestFinished(() => controller.abort())
  const response = await app.request(
    `http://runtime.test/api/wr/events${scope === "session" ? "?sessionID=ses_runtime_private" : ""}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "x-workspace-id": "ws_runtime_private",
        "x-forwarded-by": "workspace-relay",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
      signal: controller.signal,
    },
  )
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
      const data = lines
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
      if (!data) continue
      const parsed = JSON.parse(data)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      frames.push({
        ...(lines
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim()
          ? {
              id: lines
                .find((line) => line.startsWith("id:"))!
                .slice(3)
                .trim(),
            }
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
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timed out waiting for SSE frame")), 1_000),
          ),
        ])
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
      }
      drain()
      if (predicate(frames)) return [...frames]
      throw new Error(`SSE predicate was not satisfied: ${JSON.stringify(frames)}`)
    },
    async ended() {
      return await Promise.race([
        readNext().then((next) => next.done),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])
    },
    close: () => controller.abort(),
  }
}

const CONNECTION = "acceptance-fixture"

/** A harness whose turns record who authored them and answer "accepted"; the runtime keeps the transcript. */
function runtimeHarness() {
  const authors: unknown[] = []
  const turns: string[] = []
  const transport = new FakeTransport({
    capabilities: { instructionChannel: "none" },
    turn: async function* ({ session, turn }) {
      authors.push(turn.prompt.author)
      turns.push(turn.userMessageId)
      yield { type: "text-delta", delta: "accepted" }
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
  return { transport, authors, turns }
}

describe("two-user signed runtime transport acceptance", () => {
  test("binds authenticated identities to scoped RHTs across HTTP, checkpoint projection, live/replay, reconnect, and revocation", async () => {
    const alice = await person("alice", "Alice")
    const bob = await person("bob", "Bob")
    const casey = await person("casey", "Casey")
    const aliceAuth = alice.auth
    const bobAuth = bob.auth
    const caseyAuth = casey.auth
    const aliceIdentity = alice.identity
    const bobIdentity = bob.identity

    await authority.createCloudWorkspace(aliceAuth, {
      workspaceId: "ws_runtime_private",
      displayName: "Runtime transport acceptance",
      repoUrl: "https://github.com/acme/runtime-private.git",
    })
    const workspaceRow = await database.database
      .prepare("SELECT org_id FROM workspaces WHERE workspace_id = ?")
      .bind("ws_runtime_private")
      .first<{ org_id: string }>()
    if (!workspaceRow) throw new Error("Workspace was not created")
    for (const auth of [bobAuth, caseyAuth]) {
      await inviteOrgMember(database.database, aliceAuth, {
        orgId: workspaceRow.org_id,
        userPublicId: auth.principal!.userId,
        role: "member",
      })
    }

    const key = await generateKeyPair("EdDSA", { extractable: true })
    const [privateKeyPem, publicKeyPem] = await Promise.all([exportPKCS8(key.privateKey), exportSPKI(key.publicKey)])
    const oracle = new Hono().route(
      "/api/runtime-authority",
      RuntimeSessionAuthorityRoutes({
        authority,
        turnAuthority: authority,
        env: {
          CLAXEDO_RELAY_HOST_VERIFY_PEM: publicKeyPem,
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKeyPem,
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKeyPem,
        },
      }),
    )
    // The relay mints a fresh host token per request from one recorded
    // access token; `remint` is that per-request mint.
    const remint = async (auth: SignedControlPlaneAuth, jti: string, sessionId?: string, ttlSeconds?: number) => {
      const identity = [alice, bob, casey].find((person) => person.auth === auth)!.identity
      return await mintRelayHostToken(
        {
          principalKind: "user",
          ...(ttlSeconds ? { ttlSeconds } : {}),
          parentJti: jti,
          actorId: identity.actor_id,
          userId: auth.principal!.userId,
          actorKind: identity.actor_kind,
          actorPublicId: identity.actor_public_id,
          actorName: identity.actor_name,
          ...(identity.actor_avatar_url ? { actorAvatarUrl: identity.actor_avatar_url } : {}),
          orgId: workspaceRow.org_id,
          workspaceId: "ws_runtime_private",
          hostId: "host_runtime_private",
          role: sessionId ? "viewer" : "owner",
          ...(sessionId ? { sessionId } : {}),
          backing: "cloud-vm",
        },
        key.privateKey,
        "EdDSA",
      )
    }
    const rht = async (auth: SignedControlPlaneAuth, jti: string, sessionId?: string) => {
      const identity = [alice, bob, casey].find((person) => person.auth === auth)!.identity
      await authority.recordRuntimeAccessToken(auth, {
        jti,
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
        actorId: identity.actor_id,
        actorKind: identity.actor_kind,
        role: sessionId ? "viewer" : "owner",
        ...(sessionId ? { sessionId } : {}),
        expiresAt: Date.now() + 60_000,
      })
      return await remint(auth, jti, sessionId)
    }
    const aliceRht = await rht(aliceAuth, "jti_runtime_alice")

    const fixture = runtimeHarness()
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "http://control.test/api/runtime-authority/session-authorize",
      fetch: async (input, init) => oracle.request(fetchUrl(input), init),
    })
    const workspaceDirectory = path.join(root, "workspace")
    await fs.mkdir(workspaceDirectory, { recursive: true })
    const runtime = createWorkspaceRuntimeApp({
      sessionIdWorkspace: () => undefined,
      exposure: relayWorkspaceRuntimeExposure({
        key: key.publicKey,
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
      }),
      placement: loopbackMachineLoginPolicy(),
      target: { workspaceId: "ws_runtime_private", directory: workspaceDirectory },
      storeRoot: path.join(root, "runtime-state"),
      connectionProviders: [fakeConnectionProvider({ providerKey: CONNECTION, transport: () => fixture.transport })],
      sessionAccessPolicy: policy,
      // A revocation reaches a delivered session at the renewal cadence, not
      // on its next frame; the cadence is shortened so `ended()` sees it.
      renewalIntervalMs: 200,
    })
    onTestFinished(() => runtime.dispose())
    await runtime.host.apply({
      version: 4,
      commands: [],
      mcp: {},
      auth: {
        machineOwnerUserId: aliceAuth.principal!.userId,
        accounts: { [aliceAuth.principal!.userId]: {} },
      },
      connections: [
        { connectionId: CONNECTION, providerKey: CONNECTION, configRevision: 1, enabled: true, config: {} },
      ],
      defaultHarness: { kind: "connection", connectionId: CONNECTION },
    })
    const runtimeApp = runtime.app
    const sessionBus = runtime.host.sessionCore.bus

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

    const shared = await signedRequest(alice.token, "/api/control/sessions/ses_runtime_private/shares", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "ws_runtime_private",
        grantedToUserId: bobAuth.principal!.userId,
        level: "send",
      }),
    })
    expect(shared.status, await shared.clone().text()).toBe(200)

    const otherReserved = await signedRequest(alice.token, "/api/control/session-registrations/reserve", {
      method: "POST",
      body: JSON.stringify({
        operationId: "op_runtime_other",
        sessionId: "ses_other",
        workspaceId: "ws_runtime_private",
        kind: "create",
        title: "Casey's shared session",
      }),
    })
    expect(otherReserved.status, await otherReserved.clone().text()).toBe(201)
    const other = await runtimeRequest(runtimeApp, aliceRht, "/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": "op_runtime_other" },
      body: JSON.stringify({ id: "ses_other", title: "Casey's shared session" }),
    })
    expect(other.status, await other.clone().text()).toBe(201)
    await authority.grantSessionShare!(aliceAuth, {
      sessionId: "ses_other",
      workspaceId: "ws_runtime_private",
      grantedToUserId: caseyAuth.principal!.userId,
      level: "follow",
    })
    const [bobRht, caseyRht] = await Promise.all([
      rht(bobAuth, "jti_runtime_bob", "ses_runtime_private"),
      rht(caseyAuth, "jti_runtime_casey", "ses_other"),
    ])
    for (const auth of [bobAuth, caseyAuth]) {
      await expect(
        authority.recordRuntimeAccessToken(auth, {
          jti: `workspace-denied-${auth.principal!.userId}`,
          workspaceId: "ws_runtime_private",
          hostId: "host_runtime_private",
          actorId: auth.principal!.actorId,
          actorKind: "human",
          role: "editor",
          expiresAt: Date.now() + 60_000,
        }),
      ).rejects.toMatchObject({ status: 403 })
    }
    const bobReserved = await signedRequest(bob.token, "/api/control/session-registrations/reserve", {
      method: "POST",
      body: JSON.stringify({
        operationId: "op_runtime_bob",
        sessionId: "ses_runtime_bob",
        workspaceId: "ws_runtime_private",
        kind: "create",
      }),
    })
    expect(bobReserved.status).toBe(403)
    const hijack = await runtimeRequest(runtimeApp, bobRht, "/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": "op_runtime_bob" },
      body: JSON.stringify({ id: "ses_runtime_private", title: "Renamed by Bob" }),
    })
    expect(hijack.status).toBe(403)
    expect(await hijack.text()).not.toContain("Private signed runtime")
    await expect(
      (await runtimeRequest(runtimeApp, aliceRht, "/session/ses_runtime_private")).json(),
    ).resolves.toMatchObject({ id: "ses_runtime_private", title: "Private signed runtime" })

    const [aliceList, bobList, caseyList] = await Promise.all([
      runtimeRequest(runtimeApp, aliceRht, "/session"),
      runtimeRequest(runtimeApp, bobRht, "/session"),
      runtimeRequest(runtimeApp, caseyRht, "/session"),
    ])
    expect(((await aliceList.json()) as Array<{ id: string }>).map((session) => session.id).sort()).toEqual([
      "ses_other",
      "ses_runtime_private",
    ])
    for (const scoped of [bobList, caseyList]) {
      expect(scoped.status).toBe(403)
      await expect(scoped.json()).resolves.toMatchObject({ error: { code: "relay_scope_denied" } })
    }

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
      body: JSON.stringify({
        messageID: "msg_bob_runtime",
        author: { id: "forged", name: "Mallory", kind: "human" },
        parts: [{ type: "text", text: "Bob replied" }],
      }),
    })
    expect(bobPrompt.status).toBe(204)
    expect(await bobPrompt.text()).toBe("")
    await vi.waitFor(() => {
      expect(fixture.turns).toContain("msg_bob_runtime")
    })

    const transcript = await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private/message")
    expect(transcript.status).toBe(200)
    const transcriptRows = (await transcript.json()) as Array<{ info: { id: string; claxedo?: { author?: unknown } } }>
    expect(fixture.authors).toEqual([
      expect.objectContaining({ id: aliceIdentity.actor_public_id, name: "Alice" }),
      expect.objectContaining({ id: bobIdentity.actor_public_id, name: "Bob" }),
    ])
    expect(
      transcriptRows
        .filter((row) => row.info.id === "msg_alice_runtime" || row.info.id === "msg_bob_runtime")
        .map((row) => row.info.claxedo?.author),
    ).toEqual([
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
    expect(JSON.stringify(transcriptRows)).not.toContain(aliceAuth.user.tokenIdentifier)
    expect(JSON.stringify(transcriptRows)).not.toContain(bobAuth.user.tokenIdentifier)

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://runtime-checkpoint.test/")) return await runtimeFetch(input, init)
      return await originalFetch(input, init)
    }) as typeof globalThis.fetch
    const checkpointApp = new Hono().route(
      "/api/workspace",
      WorkspaceCheckpointRoutes(services, {
        loopbackRelayUrl: "http://runtime-checkpoint.test",
        authentication,
      }),
    )
    const [aliceCheckpoints, bobCheckpoints, caseyCheckpoints] = await Promise.all([
      checkpointApp.request(
        "http://control.test/api/workspace/ws_runtime_private/checkpoints",
        signedInit(alice.token),
      ),
      checkpointApp.request("http://control.test/api/workspace/ws_runtime_private/checkpoints", signedInit(bob.token)),
      checkpointApp.request(
        "http://control.test/api/workspace/ws_runtime_private/checkpoints",
        signedInit(casey.token),
      ),
    ])
    expect(aliceCheckpoints.status, await aliceCheckpoints.clone().text()).toBe(200)
    expect(bobCheckpoints.status).toBe(403)
    expect(caseyCheckpoints.status).toBe(403)
    await expect(aliceCheckpoints.json()).resolves.toMatchObject({
      worktrees: [{ sessionId: "ses_runtime_private" }, { directory: "/workspace/shared" }],
    })
    const aliceWide = await connect(
      runtimeApp,
      await remint(aliceAuth, "jti_runtime_alice", undefined, 1),
      undefined,
      "workspace",
    )
    for (const token of [bobRht, caseyRht]) {
      expect((await runtimeRequest(runtimeApp, token, "/api/wr/events")).status).toBe(403)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    sessionBus.publish({
      type: "pty.created",
      info: {
        id: "workspace-terminal",
        title: "t",
        command: "sh",
        args: [],
        cwd: workspaceDirectory,
        status: "running",
        pid: 1,
      },
    })
    sessionBus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: workspaceDirectory,
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "wide-private" },
      ts: 1,
    })
    const widePayload = (frame: { data: Record<string, unknown> }) =>
      frame.data.payload as { type?: string; info?: { id?: string; title?: string } } | undefined
    const aliceWideFrames = await aliceWide.until((frames) =>
      frames.some((frame) => widePayload(frame)?.info?.title === "wide-private"),
    )
    expect(aliceWideFrames.some((frame) => widePayload(frame)?.info?.id === "workspace-terminal")).toBe(true)
    aliceWide.close()

    const bobLive = await connect(runtimeApp, bobRht)
    const caseyLive = await runtimeApp.request("http://runtime.test/api/wr/events?sessionID=ses_runtime_private", {
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
      directory: workspaceDirectory,
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "live-private" },
      ts: 1,
    })
    sessionBus.publish({
      type: "pty.created",
      info: {
        id: "public-terminal",
        title: "t",
        command: "sh",
        args: [],
        cwd: workspaceDirectory,
        status: "running",
        pid: 1,
      },
    })
    const control = (frame: { data: Record<string, unknown> }) =>
      frame.data.payload as { info?: { title?: string }; sessionID?: string } | undefined
    const bobLiveFrames = await bobLive.until((frames) =>
      frames.some((frame) => control(frame)?.info?.title === "live-private"),
    )
    const bobCursor = bobLiveFrames.findLast((frame) => frame.id)?.id
    expect(bobCursor).toBeTruthy()
    bobLive.close()

    sessionBus.publish({
      type: "session.lifecycle",
      phase: "creating",
      directory: workspaceDirectory,
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "during-reconnect-gap" },
      ts: 2,
    })
    // Reconnecting through the relay presents a host token minted afresh for
    // this request; the cursor resumes because the scope is the actor's.
    const bobReconnectRht = await remint(bobAuth, "jti_runtime_bob", "ses_runtime_private")
    expect(bobReconnectRht).not.toBe(bobRht)
    const bobReconnect = await connect(runtimeApp, bobReconnectRht, bobCursor)
    const replay = await bobReconnect.until((frames) =>
      frames.some((frame) => control(frame)?.info?.title === "during-reconnect-gap"),
    )
    expect(replay.some((frame) => control(frame)?.sessionID === "ses_runtime_private")).toBe(true)

    const removed = await signedRequest(alice.token, "/api/control/sessions/ses_runtime_private/shares", {
      method: "DELETE",
      body: JSON.stringify({
        workspaceId: "ws_runtime_private",
        grantedToUserId: bobAuth.principal!.userId,
      }),
    })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    await expect(
      authority.runtimeAccessTokenActive({
        jti: "jti_runtime_bob",
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
      }),
    ).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    // The revocation reaches the stream at its renewal cadence, which the
    // handler above runs at 200 ms; a frame of the session published before
    // that tick is delivered from the held grant.
    expect(await bobReconnect.ended()).toBe(true)
    bobReconnect.close()
    expect((await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private")).status).toBe(403)
  }, 30_000)
})

async function person(subject: string, name: string) {
  const identity = { adapter: "better-auth" as const, issuer: "https://auth.test", subject }
  const mapped = await authority.ensureApplicationIdentity(identity)
  if (mapped.state !== "active") throw new Error(`Identity was not active: ${mapped.state}`)
  const base = await testRequestAuthenticationAdapter().authenticate(
    new Request("https://control.test", {
      headers: { authorization: `Bearer ${subject}` },
    }),
  )
  const principal = { ...base, userId: mapped.userId, actorId: mapped.actorId, identity }
  principals.set(subject, principal)
  const auth: SignedControlPlaneAuth = {
    mode: "signed",
    principal,
    user: { subject, issuer: identity.issuer, tokenIdentifier: `${identity.issuer}|${subject}` },
  }
  return {
    token: subject,
    auth,
    identity: {
      actor_id: mapped.actorId,
      actor_kind: "human" as const,
      actor_public_id: mapped.actorId,
      actor_name: name,
      actor_avatar_url: `https://images.example.test/${subject}.png`,
    },
  }
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
