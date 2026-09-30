import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "../../../workspace-relay/src/auth"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createWorkspaceRuntimeApp } from "../../../workspace-runtime/src/server"
import { relayWorkspaceRuntimeExposure } from "../../../workspace-runtime/src/exposure"
import { workspaceRuntimeBus } from "../../../workspace-runtime/src/bus"
import { remoteWorkspaceSessionAccessPolicy } from "../../../workspace-runtime/src/remote-session-authority"
import { FakeTransport, fakeConnectionProvider, loopbackMachineLoginPolicy } from "../../../workspace-runtime/src/testing"
import { WorkspaceCheckpointRoutes } from "../workspace/routes/checkpoints"
import { RuntimeSessionAuthorityRoutes } from "../routes/runtime-session-authority"
import { fetchUrl } from "../test-support/fetch-calls"

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
  { removeTestDataDir },
] = await Promise.all([
  import("../deployments/self-hosted-node/app"),
  import("./services"),
  import("./adapters/sqlite/central-store"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority"),
  import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"),
  import("@claxedo/server-core/platform/auth/auth"),
  import("../deployments/self-hosted-node/embedded-auth"),
  import("../test-support/test-data-dir"),
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

afterAll(() => {
  globalThis.fetch = originalFetch
  inspectAuthority().close()
  embedded.close()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  removeTestDataDir(root)
})

type Stream = {
  until: (predicate: (frames: Array<{ id?: string; data: Record<string, unknown> }>) => boolean) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>
  observe: (milliseconds: number) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>
  ended: () => Promise<boolean>
  close: () => void
}

async function connect(app: Hono, token: string, lastEventId?: string, scope: "session" | "workspace" = "session"): Promise<Stream> {
  const controller = new AbortController()
  const response = await app.request(`http://runtime.test/api/wr/events${scope === "session" ? "?sessionID=ses_runtime_private" : ""}`, {
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
    const membershipNow = Date.now()
    // A rank on the workspace's project, plus the organization membership the
    // session authority asks of everyone it admits.
    const workspaceRow = inspectAuthority()
      .prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = 'ws_runtime_private'")
      .get() as { org_id: string; project_id: string }
    for (const identity of [bobIdentity, caseyIdentity]) {
      inspectAuthority().prepare(`
        INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
        VALUES (?, ?, 'editor', ?, ?)
      `).run(workspaceRow.project_id, identity.token_identifier, membershipNow, membershipNow)
      inspectAuthority().prepare(`
        INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
        VALUES (?, ?, 'member', ?, ?)
      `).run(workspaceRow.org_id, identity.token_identifier, membershipNow, membershipNow)
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
    // The relay mints a fresh host token per request from one recorded
    // access token; `remint` is that per-request mint.
    const remint = async (auth: SignedAuth, jti: string, role: "editor" | "owner" = "editor", ttlSeconds?: number) => {
      const identity = await profile(auth)
      return await mintRelayHostToken({
        principalKind: "user",
        ...(ttlSeconds ? { ttlSeconds } : {}),
        parentJti: jti,
        actorId: identity.actor_id,
        userId: auth.user.subject,
        actorKind: identity.actor_kind,
        actorPublicId: identity.actor_public_id,
        actorName: identity.actor_name,
        ...(identity.actor_avatar_url ? { actorAvatarUrl: identity.actor_avatar_url } : {}),
        orgId: identity.org_id,
        workspaceId: "ws_runtime_private",
        hostId: "host_runtime_private",
        role,
        backing: "cloud-vm",
      }, key.privateKey, "EdDSA")
    }
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
      return await remint(auth, jti, role)
    }
    const [aliceRht, bobRht, caseyRht] = await Promise.all([
      rht(aliceAuth, "jti_runtime_alice", "owner"),
      rht(bobAuth, "jti_runtime_bob"),
      rht(caseyAuth, "jti_runtime_casey"),
    ])

    const sessionBus = workspaceRuntimeBus
    const fixture = runtimeHarness()
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "http://control.test/api/runtime-authority/session-authorize",
      fetch: async (input, init) => oracle.request(fetchUrl(input), init),
    })
    const workspaceDirectory = path.join(root, "workspace")
    await fs.mkdir(workspaceDirectory, { recursive: true })
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({ key: key.publicKey, workspaceId: "ws_runtime_private", hostId: "host_runtime_private" }),
      placement: loopbackMachineLoginPolicy(),
      target: { workspaceId: "ws_runtime_private", directory: workspaceDirectory },
      storeRoot: path.join(root, "runtime-state"),
      connectionProviders: [fakeConnectionProvider({ providerKey: CONNECTION, transport: () => fixture.transport })],
      sessionAccessPolicy: policy,
      // A revocation reaches a delivered session at the renewal cadence, not
      // on its next frame; the cadence is shortened so `ended()` sees it.
      renewalIntervalMs: 200,
    })
    await runtime.host.apply({
      version: 4,
      commands: [],
      mcp: {},
      auth: { machineOwnerUserId: "local", accounts: { local: {} } },
      connections: [{ connectionId: CONNECTION, providerKey: CONNECTION, configRevision: 1, enabled: true, config: {} }],
      defaultHarness: { kind: "connection", connectionId: CONNECTION },
    })
    const runtimeApp = runtime.app

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

    // Bob participates in Alice's session and holds a reservation of his own.
    // Neither lets a create name her id: the reservation says which session it
    // may bring into being, and the runtime asks before it configures, renames
    // or rolls anything back.
    const bobReserved = await signedRequest(bob.token, "/api/control/session-registrations/reserve", {
      method: "POST",
      body: JSON.stringify({
        operationId: "op_runtime_bob",
        sessionId: "ses_runtime_bob",
        workspaceId: "ws_runtime_private",
        kind: "create",
      }),
    })
    expect(bobReserved.status, await bobReserved.clone().text()).toBe(201)
    const hijack = await runtimeRequest(runtimeApp, bobRht, "/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": "op_runtime_bob" },
      body: JSON.stringify({ id: "ses_runtime_private", title: "Renamed by Bob" }),
    })
    expect(hijack.status).toBe(403)
    expect(await hijack.text()).not.toContain("Private signed runtime")
    const unreserved = await runtimeRequest(runtimeApp, bobRht, "/session", {
      method: "POST",
      body: JSON.stringify({ id: "ses_runtime_private", title: "Renamed by Bob" }),
    })
    expect(unreserved.status).toBe(400)
    await expect(
      (await runtimeRequest(runtimeApp, aliceRht, "/session/ses_runtime_private")).json(),
    ).resolves.toMatchObject({ id: "ses_runtime_private", title: "Private signed runtime" })

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
      expect(fixture.turns).toContain("msg_bob_runtime")
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

    // The unscoped arm, on the real authority: everyone the workspace admits
    // opens it; the session authority decides per session what each receives.
    // Alice's host token dies a second after her stream opens: the session's
    // first frame reaches the connection later than that, so what admits it
    // is the workspace lease her admission minted, not the request's token.
    const aliceWide = await connect(runtimeApp, await remint(aliceAuth, "jti_runtime_alice", "owner", 1), undefined, "workspace")
    const bobWide = await connect(runtimeApp, bobRht, undefined, "workspace")
    const caseyWide = await connect(runtimeApp, caseyRht, undefined, "workspace")
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    sessionBus.publish({ type: "pty.created", info: { id: "workspace-terminal", title: "t", command: "sh", args: [], cwd: workspaceDirectory, status: "running", pid: 1 } })
    sessionBus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: workspaceDirectory,
      sessionID: "ses_runtime_private",
      info: { id: "ses_runtime_private", title: "wide-private" },
      ts: 1,
    })
    const widePayload = (frame: { data: Record<string, unknown> }) => frame.data.payload as { type?: string; info?: { id?: string; title?: string } } | undefined
    const aliceWideFrames = await aliceWide.until((frames) => frames.some((frame) => widePayload(frame)?.info?.title === "wide-private"))
    expect(aliceWideFrames.some((frame) => widePayload(frame)?.info?.id === "workspace-terminal")).toBe(true)
    const bobWideFrames = await bobWide.until((frames) => frames.some((frame) => widePayload(frame)?.info?.title === "wide-private"))
    expect(bobWideFrames.some((frame) => widePayload(frame)?.info?.id === "workspace-terminal")).toBe(true)
    const caseyWideFrames = await caseyWide.until((frames) => frames.some((frame) => widePayload(frame)?.info?.id === "workspace-terminal"))
    const caseyLater = await caseyWide.observe(300)
    expect([...caseyWideFrames, ...caseyLater].some((frame) => widePayload(frame)?.info?.title === "wide-private")).toBe(false)
    aliceWide.close()
    bobWide.close()
    caseyWide.close()

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
    sessionBus.publish({ type: "pty.created", info: { id: "public-terminal", title: "t", command: "sh", args: [], cwd: workspaceDirectory, status: "running", pid: 1 } })
    const control = (frame: { data: Record<string, unknown> }) => frame.data.payload as { info?: { title?: string }; sessionID?: string } | undefined
    const bobLiveFrames = await bobLive.until((frames) => frames.some((frame) => control(frame)?.info?.title === "live-private"))
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
    const bobReconnectRht = await remint(bobAuth, "jti_runtime_bob")
    expect(bobReconnectRht).not.toBe(bobRht)
    const bobReconnect = await connect(runtimeApp, bobReconnectRht, bobCursor)
    const replay = await bobReconnect.until((frames) => frames.some((frame) => control(frame)?.info?.title === "during-reconnect-gap"))
    expect(replay.some((frame) => control(frame)?.sessionID === "ses_runtime_private")).toBe(true)

    const removed = await signedRequest(alice.token, "/api/control/sessions/ses_runtime_private/participants", {
      method: "DELETE",
      body: JSON.stringify({
        workspaceId: "ws_runtime_private",
        participantActorId: bobIdentity.actor_id,
      }),
    })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toMatchObject({ removed: true })
    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_runtime_bob",
      workspaceId: "ws_runtime_private",
      hostId: "host_runtime_private",
    })).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    // The revocation reaches the stream at its renewal cadence, which the
    // handler above runs at 200 ms; a frame of the session published before
    // that tick is delivered from the held grant.
    expect(await bobReconnect.ended()).toBe(true)
    bobReconnect.close()
    expect((await runtimeRequest(runtimeApp, bobRht, "/session/ses_runtime_private")).status).toBe(403)
    await expect((await runtimeRequest(runtimeApp, bobRht, "/session")).json()).resolves.toEqual([])
    await runtime.dispose()
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
  return auth
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
