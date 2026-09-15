import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { NO_HARNESS_EFFORT, type ConnectionProvider, type HarnessConnectionCapabilities } from "@claxedo/agent-sdk-runtime"
import type { AgentMessage, AgentPermissionMode, SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { MemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  createRuntimeCredentialIssuer,
  createWorkspaceRuntimeApp,
  ownerGrantIdentity,
  remoteWorkspaceSessionAccessPolicy,
  type WorkspaceRuntimeApp,
} from "@claxedo/workspace-runtime"
import { relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { RuntimeSessionAuthorityRoutes } from "../../routes/runtime-session-authority"
import { createOwnerGrantProof, mintOwnerGrant } from "../../session/owner-grant"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { firstPartyMcpRuntimeContribution } from "./first-party-mcp"
import { workspaceRuntimeOwnerGrant } from "./owner-grant"

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
    if (!session || session.creator !== input.actorId) {
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
 * An in-process harness: sessions and turns in memory, permission modes with
 * rungs, no model of its own. A held turn never settles until released, which
 * is how a child is kept active for the cap rule.
 */
function fakeHarness() {
  const store = new MemoryRuntimeStore()
  const prompts: Array<{ sessionId: string; messageID?: string }> = []
  let holding = false
  const held: Array<() => void> = []
  const config: SessionConfig = { harness: { id: CONNECTION, access: "connection" }, variant: null, agent: null }
  let counter = 0
  const adapter: AgentHarnessAdapter = {
    instructionChannel: "turn-system-prompt",
    // The runtime keeps the config, so the group a create names is read back from the runtime's own store.
    sessionConfigOwner: "runtime",
    getSession: async (binding) => store.getSession(binding.sessionId) ?? null,
    createSession: async (directory, title, id) => {
      const sessionId = id ?? `ses_fake_${++counter}`
      store.bindSession({ sessionId, directory: directory ?? process.cwd(), ...(title ? { title } : {}), agentSessionId: sessionId })
      store.updateSessionConfig(sessionId, config)
      return { id: sessionId }
    },
    updateSession: async (binding, updates) => store.updateSession(binding.sessionId, updates),
    getSessionConfig: async (binding) => store.getSessionConfig(binding.sessionId) ?? config,
    updateSessionConfig: async (binding, patch) => store.updateSessionConfig(binding.sessionId, patch) ?? config,
    deleteSession: async (binding) => { store.deleteSession(binding.sessionId) },
    readHarnessCapabilities: () => ({
      harness: CONNECTION,
      ...CAPABILITIES,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
      goals: false,
    }),
    executeTurn: (binding, prompt) => {
      prompts.push({ sessionId: binding.sessionId, messageID: prompt.userMessageId })
      const hold = holding
      return (async function* () {
        if (hold) await new Promise<void>((resolve) => held.push(resolve))
      })()
    },
    getMessages: async (): Promise<AgentMessage[]> => [],
    abort: async () => ({ ok: true, status: "cancelled" }),
    executeCommand: async () => {},
    listCommands: async () => [],
    listAgents: async () => [],
    getTodos: async () => [],
    listPermissions: async () => [],
    respondPermission: async () => {},
    listQuestions: async () => [],
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    applyConfig: async () => {},
    probeConfigOptions: async () => ({ options: [] }),
    listDraftPermissionModes: async () => ({ modes: [...MODES], appliesFrom: "next-turn" }),
    listPermissionModes: async () => ({ modes: [...MODES], currentModeId: "workspace-write", appliesFrom: "next-turn" }),
    setPermissionMode: async (_binding, modeId) => ({ modes: [...MODES], currentModeId: modeId, appliesFrom: "next-turn" }),
    dispose: () => {},
  }
  return {
    adapter,
    prompts,
    hold: () => { holding = true },
    release: () => {
      holding = false
      for (const resolve of held.splice(0)) resolve()
    },
  }
}

function fakeProvider(adapter: AgentHarnessAdapter): ConnectionProvider<Record<string, never>> {
  return {
    providerKey: "fake",
    validateConfig: () => ({}),
    project: () => ({ label: "Fake harness", readiness: "ready", capabilities: CAPABILITIES }),
    resolve: () => ({ config: {} }),
    createAdapter: () => adapter,
  }
}

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
    exposure: relayWorkspaceRuntimeExposure({ key: relayKey.publicKey, workspaceId: WORKSPACE, hostId: HOST }),
    target: { workspaceId: WORKSPACE, directory },
    storeRoot: path.join(directory, "state"),
    connectionProviders: [fakeProvider(harness.adapter)],
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
      }),
    ],
  })
  await runtime.host.apply({
    version: 4,
    mcp: {},
    connections: [{ connectionId: CONNECTION, providerKey: "fake", configRevision: 1, enabled: true, config: {} }],
    auth: {},
  })
}, 60_000)

afterAll(async () => {
  harness?.release()
  await runtime?.host.dispose()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

/** A root session created the way the app creates one: reserved on the plane, then created over the relay with the reservation. */
async function createRoot(sessionId: string, creator: WorkspaceOwnerIdentity) {
  const operationId = `session_registration_${sessionId}`
  records.reserve({ principalKind: "user", actorId: creator.actorId, actorKind: "human" }, { operationId, sessionId })
  const token = await mintRelayHostToken({
    principalKind: "user",
    actorId: creator.actorId,
    actorKind: "human",
    orgId: creator.orgId,
    workspaceId: WORKSPACE,
    hostId: HOST,
    role: "owner",
    access: "cloud",
    backing: "cloud-vm",
    jti: `rht_${sessionId}`,
    parentJti: `rat_${creator.actorId}`,
  }, relayKey.privateKey, "EdDSA")
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
