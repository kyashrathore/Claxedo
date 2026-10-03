import type { AgentPermissionMode, AgentPermissionModeState } from "@claxedo/agent-runtime-contract"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import { loopbackMachineLoginPolicy } from "@claxedo/workspace-runtime/testing"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  createRuntimeCredentialIssuer,
  createWorkspaceRuntimeApp,
  ownerGrantIdentity,
  type WorkspaceRuntimeApp,
} from "@claxedo/workspace-runtime"
import { remoteWorkspaceSessionAccessPolicy } from "@claxedo/session-core"
import { relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { RuntimeSessionAuthorityRoutes } from "../../routes/runtime-session-authority"
import { createOwnerGrantProof, mintOwnerGrant } from "../../session/owner-grant"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { firstPartyMcpRuntimeContribution } from "./first-party-mcp"
import { workspaceRuntimeOwnerGrant } from "./owner-grant"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"

/**
 * `create_subagent` on a hosted cloud root, end to end: the real MCP mount
 * over the real runtime kit routes, a relay-exposed runtime whose session
 * policy is the remote oracle, and the real session-authority route on the
 * other side of it, with an owner grant minted by the real minter. Only the
 * authority's records and the harness are in memory: sessions, reservations
 * and turns are kept by a fake that refuses what the D1 adapter would refuse,
 * and the harness is an in-process connection provider whose adapter offers
 * leveled permission modes, which the child ceiling rule needs on both sides.
 */

const ALICE: WorkspaceOwnerIdentity = { userId: "alice", actorId: "actor:alice", orgId: "org_1", projectId: "project_a" }
const BOB: WorkspaceOwnerIdentity = { userId: "bob", actorId: "actor:bob", orgId: "org_1", projectId: "project_a" }
const WORKSPACE = "ws_1"
const HOST = "host_1"

type Reservation = { sessionId: string; creator: string; parentSessionId?: string; title?: string; state: "reserved" | "registered" }
type SessionRow = { creator: string; workspaceId: string; parentSessionId?: string }

/** The plane's own records: who may open which session, and which reservations became sessions. */
class Records {
  readonly owners: Record<string, WorkspaceOwnerIdentity | undefined> = { [WORKSPACE]: ALICE }
  readonly reservations = new Map<string, Reservation>()
  readonly sessions = new Map<string, SessionRow>()
  readonly turns: Array<{ actorId: string; sessionId: string; turnId: string }> = []
  /** `${sessionId}:${actorId}` for every session shared with someone other than its creator. */
  readonly shares = new Set<string>()

  reserve(principal: PrivateSessionRuntimePrincipal, intent: { operationId: string; sessionId: string; parentSessionId?: string; title?: string }) {
    this.reservations.set(intent.operationId, {
      sessionId: intent.sessionId,
      creator: principal.actorId,
      ...(intent.parentSessionId ? { parentSessionId: intent.parentSessionId } : {}),
      ...(intent.title ? { title: intent.title } : {}),
      state: "reserved",
    })
  }

  register(input: { actorId: string; operationId: string; sessionId: string; workspaceId: string }) {
    const reservation = this.reservations.get(input.operationId)
    if (!reservation || reservation.sessionId !== input.sessionId || reservation.creator !== input.actorId) {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "A matching session reservation is required")
    }
    reservation.state = "registered"
    this.sessions.set(input.sessionId, {
      creator: reservation.creator,
      workspaceId: input.workspaceId,
      ...(reservation.parentSessionId ? { parentSessionId: reservation.parentSessionId } : {}),
    })
  }

  authorize(input: { actorId: string; sessionId: string; action: string }) {
    const session = this.sessions.get(input.sessionId)
    if (!session || (session.creator !== input.actorId && !this.shares.has(`${input.sessionId}:${input.actorId}`))) {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", `${input.actorId} cannot ${input.action} ${input.sessionId}`)
    }
  }
}

type Binding = { kind: string; subagentKey: string; sessionId: string; status?: string }

const CONNECTION = "fake-1"
const MODES: readonly AgentPermissionMode[] = [
  { id: "read-only", name: "Read only", level: "ask" },
  { id: "workspace-write", name: "Workspace write", level: "auto" },
]
const CAPABILITIES: HarnessConnectionCapabilities = {
  abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: true,
  commands: true, fork: false, revert: false, unrevert: false, configOptions: false, subagents: true,
}

/**
 * An in-process harness: turns in memory, permission modes with rungs, and the
 * one model the parent's group names. A held turn never settles until
 * released, which is how a child is kept active for the cap rule.
 */
function fakeHarness() {
  const prompts: Array<{ sessionId: string; messageID?: string }> = []
  let holding = false
  const held: Array<() => void> = []
  let currentMode = "workspace-write"
  const modes = (): AgentPermissionModeState => ({ modes: [...MODES], currentModeId: currentMode, appliesFrom: "next-turn" })
  const transport = new FakeTransport({
    capabilities: {
      instructionChannel: "turn-system-prompt", subagents: true,
      requests: { permissions: true, questions: true, elicitation: false },
      modelSelection: { status: "optional", models: [{ providerId: "fake", modelId: "m1", name: "Fake M1" }] },
    },
    turn: async function* ({ session, turn }) {
      prompts.push({ sessionId: session.binding.sessionId, messageID: turn.userMessageId })
      if (holding) await new Promise<void>((resolve) => held.push(resolve))
    },
    config: {
      options: async () => ({ options: [] }),
      permissionModes: async () => modes(),
      setPermissionMode: async (_session, modeId) => {
        currentMode = modeId
        return modes()
      },
    },
  })
  return {
    transport,
    prompts,
    hold: () => { holding = true },
    release: () => {
      holding = false
      for (const resolve of held.splice(0)) resolve()
    },
  }
}

const fakeProvider = (transport: FakeTransport) =>
  fakeConnectionProvider({ providerKey: "fake", label: "Fake harness", capabilities: CAPABILITIES, transport: () => transport })

/** The parent's model group: the one way `create_subagent` names a connection harness for the child. */
const GROUP = { implementation: { harness: { id: CONNECTION, access: "connection" }, model: { providerID: "fake", modelID: "m1" } } }

let records: Records
let runtime: WorkspaceRuntimeApp
let issuer: ReturnType<typeof createRuntimeCredentialIssuer>
let signingEnv: Record<string, string>
let relayKey: CryptoKeyPair
let grant: ReturnType<typeof workspaceRuntimeOwnerGrant>
let harness: ReturnType<typeof fakeHarness>
let directory: string

beforeAll(async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  relayKey = await generateKeyPair("EdDSA", { extractable: true })
  signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  records = new Records()
  const passes = memorySandboxPassRegister()
  const authority = testManagedSessionAuthority({
    reserveRuntimeSession: async (principal, intent) => {
      records.reserve(principal, intent)
      return { changed: true, operationId: intent.operationId, sessionId: intent.sessionId, workspaceId: intent.workspaceId, state: "reserved" }
    },
    registerRuntimeSession: async (input) => {
      records.register(input)
      return {}
    },
    authorizeRuntimeSession: async (input) => records.authorize(input),
    acquireSessionTurn: async (input) => {
      records.authorize({ actorId: input.actorId, sessionId: input.sessionId, action: "turn" })
      records.turns.push({ actorId: input.actorId, sessionId: input.sessionId, turnId: input.turnId })
      return {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        leaseId: `lease_${records.turns.length}`,
        fencingToken: records.turns.length,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
    },
  })
  const plane = new Hono().route(
    "/api/runtime-authority",
    RuntimeSessionAuthorityRoutes({
      authority,
      turnAuthority: authority,
      env: { ...signingEnv, CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey) },
      ownerGrants: createOwnerGrantProof({ env: signingEnv, passes, resolveWorkspaceOwner: async (workspaceId) => records.owners[workspaceId] }),
    }),
  )

  const minted = await mintOwnerGrant({ ...ALICE, workspaceId: WORKSPACE }, signingEnv, { register: passes })
  grant = workspaceRuntimeOwnerGrant({ WORKSPACE_RUNTIME_OWNER_GRANT: minted.token })

  directory = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-subagents-"))
  issuer = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: WORKSPACE, userId: ALICE.userId })
  harness = fakeHarness()
  const enabledToolGroups = ["sessions", "subagents"]
  runtime = createWorkspaceRuntimeApp({
    sessionIdWorkspace: () => undefined,
    exposure: relayWorkspaceRuntimeExposure({ key: relayKey.publicKey, workspaceId: WORKSPACE, hostId: HOST }),
    target: { workspaceId: WORKSPACE, directory },
    storeRoot: path.join(directory, "state"),
    placement: loopbackMachineLoginPolicy(),
    connectionProviders: [fakeProvider(harness.transport)],
    firstPartyMcpLaunch: { baseUrl: "http://127.0.0.1:3002", issuer, enabledToolGroups: () => enabledToolGroups },
    ownerGrantIdentity: ownerGrantIdentity({ key: key.publicKey, workspaceId: WORKSPACE }),
    sessionAccessPolicy: remoteWorkspaceSessionAccessPolicy({
      url: "https://plane.test/api/runtime-authority/session-authorize",
      fetch: async (url, init) => plane.request(url, init),
    }),
    routeContributions: [
      firstPartyMcpRuntimeContribution({
        verifyRuntimeCredential: issuer.verify,
        enabledToolGroups,
        ownerGrant: () => grant?.current(),
        ownerActorId: () => grant?.actorId,
      }),
    ],
  })
  await runtime.host.apply({
    version: 4,
    commands: [],
    mcp: {},
    connections: [{ connectionId: CONNECTION, providerKey: "fake", configRevision: 1, enabled: true, config: {} }],
    auth: { machineOwnerUserId: "local", accounts: { local: {} } },
  })
}, 60_000)

afterAll(async () => {
  harness?.release()
  await runtime?.host.dispose()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

function relayToken(who: WorkspaceOwnerIdentity, jti: string) {
  return mintRelayHostToken({
    principalKind: "user",
    actorId: who.actorId,
    userId: who.userId,
    actorKind: "human",
    orgId: who.orgId,
    workspaceId: WORKSPACE,
    hostId: HOST,
    role: "owner",
    backing: "cloud-vm",
    jti,
    parentJti: `rat_${who.actorId}`,
  }, relayKey.privateKey, "EdDSA")
}

/** A root session created the way the app creates one: reserved on the plane, then created over the relay with the reservation. */
async function createRoot(sessionId: string, creator: WorkspaceOwnerIdentity) {
  const operationId = `session_registration_${sessionId}`
  records.reserve({ principalKind: "user", actorId: creator.actorId, actorKind: "human" }, { operationId, sessionId })
  const token = await relayToken(creator, `rht_${sessionId}`)
  const response = await runtime.app.request(`http://runtime.test/session?connectionId=${CONNECTION}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-workspace-id": WORKSPACE,
      "x-forwarded-by": "workspace-relay",
      "x-claxedo-session-registration-operation": operationId,
    },
    body: JSON.stringify({ id: sessionId, title: `Root ${sessionId}`, group: GROUP }),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return sessionId
}

async function readSession(sessionId: string) {
  const response = await runtime.app.request(`http://runtime.test/session/${sessionId}`, {
    headers: { authorization: `Bearer ${await relayToken(ALICE, `rht_read_${sessionId}`)}`, "x-workspace-id": WORKSPACE, "x-forwarded-by": "workspace-relay" },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as { status?: string; time?: { lastHumanTurn?: number } }
}

function rpc(session: string, credential: string, mcpSession: string | undefined, body: Record<string, unknown>) {
  return runtime.app.request(`http://127.0.0.1/api/claxedo/mcp?session=${session}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${credential}`,
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  })
}

type RpcAnswer = { result?: { isError?: boolean; content: { text?: string }[] }; error?: unknown }

function payload(body: string): RpcAnswer {
  const line = body.split("\n").find((entry) => entry.startsWith("data:")) ?? body
  return JSON.parse(line.replace(/^data:\s*/, "")) as RpcAnswer
}

/** An MCP client for one session of this runtime, as the harness the runtime launched would connect. */
async function connect(session: string) {
  // One bearer per client, as each harness process holds the one it was launched with.
  const credential = issuer.current(session)
  const opened = await rpc(session, credential, undefined, {
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "0" } },
  })
  expect(opened.status).toBe(200)
  const mcpSession = opened.headers.get("mcp-session-id") ?? ""
  await opened.text()
  return async (name: string, args: Record<string, unknown> = {}) => {
    const called = await rpc(session, credential, mcpSession, { method: "tools/call", params: { name, arguments: args } })
    const answer = payload(await called.text())
    if (!answer.result) throw new Error(`tools/call ${name} answered ${called.status}: ${JSON.stringify(answer.error ?? answer)}`)
    const result = answer.result
    const text = result.content.map((part) => part.text ?? "").join("")
    return { isError: result.isError === true, text }
  }
}

const spawn = (call: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown> = {}) =>
  call("create_subagent", { configuration: "implementation", prompt: "summarise the repository", mode: "async", ...args })

describe("create_subagent on a hosted cloud root", () => {
  test("creates the child as the workspace owner: reserved and registered on the plane under the owner's actor, prompted under the owner's turn", async () => {
    const parent = await createRoot("ses_parent", ALICE)
    const call = await connect(parent)

    const answer = await spawn(call, { role: "reviewer" })
    expect(answer.isError, answer.text).toBe(false)
    const child = JSON.parse(answer.text) as Binding
    expect(child).toMatchObject({ kind: "claxedo.subagent", subagentKey: expect.stringMatching(/^subagent_/), sessionId: expect.stringMatching(/^ses_/) })

    // The plane's records, not the runtime's answer, say who created the child.
    expect(records.sessions.get(child.sessionId)).toEqual({ creator: ALICE.actorId, workspaceId: WORKSPACE, parentSessionId: parent })
    const reservation = [...records.reservations.values()].find((row) => row.sessionId === child.sessionId)
    expect(reservation).toEqual({ sessionId: child.sessionId, creator: ALICE.actorId, parentSessionId: parent, title: "reviewer", state: "registered" })
    expect(records.turns).toContainEqual({ actorId: ALICE.actorId, sessionId: child.sessionId, turnId: `msg_subagent_${child.sessionId}` })
    expect(harness.prompts).toContainEqual({ sessionId: child.sessionId, messageID: `msg_subagent_${child.sessionId}` })

    const listed = await call("subagent_list")
    expect((JSON.parse(listed.text) as Binding[]).map((row) => row.sessionId)).toEqual([child.sessionId])
  }, 60_000)

  test("records no human turn for the turns an agent's tools start, though they run under the owner's grant", async () => {
    const parent = await createRoot("ses_parent_turns", ALICE)
    const call = await connect(parent)
    const child = (JSON.parse((await spawn(call)).text) as Binding).sessionId
    await expect.poll(async () => (await readSession(child)).status, { timeout: 10_000 }).not.toBe("busy")

    const sent = await call("session_send", { session: child, text: "keep going" })
    expect(sent.isError, sent.text).toBe(false)
    await expect.poll(() => harness.prompts.filter((prompt) => prompt.sessionId === child).length, { timeout: 10_000 }).toBe(2)

    expect((await readSession(child)).time?.lastHumanTurn).toBeUndefined()
  }, 60_000)

  test("a grant signed with another key, or minted for another workspace, leaves the runtime's own routes actor-less", async () => {
    const parent = await createRoot("ses_parent_forged", ALICE)
    const call = await connect(parent)
    const foreign = await generateKeyPair("EdDSA", { extractable: true })
    const forged = await mintOwnerGrant({ ...ALICE, workspaceId: WORKSPACE }, {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(foreign.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(foreign.publicKey),
    })
    const elsewhere = await mintOwnerGrant({ ...ALICE, workspaceId: "ws_2" }, signingEnv)
    const live = grant!.current()!
    try {
      for (const token of [forged.token, elsewhere.token]) {
        grant!.swap(token)
        const refused = await spawn(call)
        expect(refused.isError).toBe(true)
        expect(refused.text).toContain("session_actor_required")
      }
    } finally {
      grant!.swap(live)
    }
    expect([...records.sessions.values()].filter((row) => row.parentSessionId === parent)).toEqual([])
  }, 60_000)

  test("a grant whose workspace was re-owned is refused by the plane on its next use, and nothing is reserved", async () => {
    const parent = await createRoot("ses_parent_reowned", ALICE)
    const call = await connect(parent)
    records.owners[WORKSPACE] = BOB
    try {
      const refused = await spawn(call)
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain("owner_grant_invalid")
    } finally {
      records.owners[WORKSPACE] = ALICE
    }
    expect([...records.reservations.values()].filter((row) => row.parentSessionId === parent)).toEqual([])
  }, 60_000)

  test("a parent the owner cannot open gets no child: the owner's own access is the rule, not the runtime's", async () => {
    // Bob's root is registered on the plane; the runtime never sees it, and
    // never needs to, because the owner's first read is refused there.
    const operationId = "session_registration_ses_bob"
    records.reserve({ principalKind: "user", actorId: BOB.actorId, actorKind: "human" }, { operationId, sessionId: "ses_bob" })
    records.register({ actorId: BOB.actorId, operationId, sessionId: "ses_bob", workspaceId: WORKSPACE })
    const call = await connect("ses_bob")
    const refused = await spawn(call)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("workspace_authorization_denied")
    expect([...records.reservations.values()].filter((row) => row.parentSessionId === "ses_bob")).toEqual([])
  }, 60_000)

  test("the depth and cap rules hold for the owner too: no child of a child, no fifth active child", async () => {
    const parent = await createRoot("ses_parent_bounded", ALICE)
    const call = await connect(parent)
    // The cap counts children still working, so these turns are held open.
    harness.hold()
    const first = JSON.parse((await spawn(call)).text) as Binding

    // The child reads its own row through the owner grant and learns it may not spawn.
    const asChild = await connect(first.sessionId)
    const capabilities = JSON.parse((await asChild("subagent_capabilities")).text) as { canSpawn: boolean; reason?: string }
    expect(capabilities).toMatchObject({ canSpawn: false, reason: expect.stringContaining("subagent cannot start subagents") })

    for (let index = 0; index < 3; index += 1) {
      const more = await spawn(call)
      expect(more.isError, more.text).toBe(false)
    }
    const capped = await spawn(call)
    expect(capped.isError).toBe(true)
    expect(capped.text).toContain("subagent_child_cap_reached")
    expect([...records.sessions.values()].filter((row) => row.parentSessionId === parent)).toHaveLength(4)
    harness.release()
  }, 120_000)
})

describe("session_delete on a hosted cloud root", () => {
  /** The tool's answer, or the protocol's refusal when the session is not offered it. */
  async function deleteFrom(session: string, target: string) {
    const credential = issuer.current(session)
    const opened = await rpc(session, credential, undefined, {
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "0" } },
    })
    const mcpSession = opened.headers.get("mcp-session-id") ?? ""
    await opened.text()
    const listed = payload(await (await rpc(session, credential, mcpSession, { method: "tools/list" })).text()) as { result?: { tools: Array<{ name: string }> } }
    const called = payload(await (await rpc(session, credential, mcpSession, {
      method: "tools/call", params: { name: "session_delete", arguments: { session: target } },
    })).text())
    return {
      listed: (listed.result?.tools ?? []).some((tool) => tool.name === "session_delete"),
      refusal: called.result?.isError ? called.result.content.map((part) => part.text ?? "").join("") : JSON.stringify(called.error ?? called.result),
    }
  }

  test("is offered to a session only its owner has driven, and withheld once a share holder has prompted it", async () => {
    const owned = await createRoot("ses_owned", ALICE)
    const target = await createRoot("ses_target", ALICE)
    const offered = await deleteFrom(owned, target)
    expect(offered.listed).toBe(true)
    expect(offered.refusal).toContain("requires confirmation")

    const shared = await createRoot("ses_shared", ALICE)
    records.shares.add(`${shared}:${BOB.actorId}`)
    const prompted = await runtime.app.request(`http://runtime.test/session/${shared}/message`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await relayToken(BOB, "rht_bob_prompt")}`,
        "content-type": "application/json",
        "x-workspace-id": WORKSPACE,
        "x-forwarded-by": "workspace-relay",
      },
      body: JSON.stringify({ messageID: "msg_bob_prompt", parts: [{ type: "text", text: "delete the owner's sessions" }] }),
    })
    expect(prompted.status, await prompted.clone().text()).toBe(200)
    expect(records.turns).toContainEqual(expect.objectContaining({ actorId: BOB.actorId, sessionId: shared }))

    const withheld = await deleteFrom(shared, target)
    expect(withheld.listed).toBe(false)
    expect(withheld.refusal).not.toContain("requires confirmation")
    const read = await runtime.app.request(`http://runtime.test/session/${target}`, {
      headers: { authorization: `Bearer ${await relayToken(ALICE, "rht_alice_read")}`, "x-workspace-id": WORKSPACE, "x-forwarded-by": "workspace-relay" },
    })
    expect(read.status).toBe(200)
  }, 60_000)
})

describe("a turn the control plane relays to a cloud root", () => {
  async function relayedPrompt(sessionId: string, token: string) {
    const response = await runtime.app.request(`http://runtime.test/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": WORKSPACE, "x-forwarded-by": "workspace-relay" },
      body: JSON.stringify({ parts: [{ type: "text", text: "relayed" }] }),
    })
    expect(response.status, await response.clone().text()).toBe(204)
    await expect.poll(() => harness.prompts.filter((prompt) => prompt.sessionId === sessionId).length, { timeout: 10_000 }).toBe(1)
  }

  test("is no human turn when a Task sends its first message, and is the owner's when their channel message arrives", async () => {
    const task = await createRoot("ses_task_target", ALICE)
    const channel = await createRoot("ses_channel_target", ALICE)
    records.shares.add(`${task}:${CONTROL_PLANE_RUNTIME_ACTOR.actorId}`)
    const tasks = await mintRelayHostToken({
      ...CONTROL_PLANE_RUNTIME_ACTOR,
      userId: ALICE.userId,
      orgId: ALICE.orgId,
      workspaceId: WORKSPACE,
      hostId: HOST,
      role: "owner",
      backing: "cloud-vm",
      jti: "rht_task_dispatch",
      parentJti: "rat_control_plane",
    }, relayKey.privateKey, "EdDSA")

    await relayedPrompt(task, tasks)
    await relayedPrompt(channel, await relayToken(ALICE, "rht_channel_message"))

    expect((await readSession(task)).time?.lastHumanTurn).toBeUndefined()
    expect(typeof (await readSession(channel)).time?.lastHumanTurn).toBe("number")
  }, 60_000)
})
