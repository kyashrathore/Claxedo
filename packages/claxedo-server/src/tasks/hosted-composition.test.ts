/**
 * Tasks through the real hosted app, with the real signed-request path and the
 * real D1 schema. Most of the file stubs the session bridge, because Start is
 * the one thing in this feature that is not this composition's: everything
 * those tests assert — who the caller is, which organization their rows
 * belong to, and what the authority lets them reach — is decided before the
 * bridge is ever consulted. The journey at the end runs the real hosted
 * bridge instead, because who a cloud root is created as is decided by the
 * composition and the bridge together.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { Hono } from "hono"
import type { D1Database } from "@cloudflare/workers-types"
import { createSandboxManager, type SandboxDriver } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { deleteWorkspace, ensureWorkspace, listWorkspaces } from "@claxedo/server-core/workspace/store/index"
import { memorySandboxPassRegister, type SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import type { TasksActor, TasksSessionBridgePort } from "@claxedo/tasks"
import type { TasksRuntimePrincipal } from "@claxedo/server-core/tasks-host/authorization"

import { createHostedCoreApp } from "../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../authority/hosted-services"
import type { ControlPlaneServices } from "../authority/services"
import {
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"
import { mintTasksCapability, TASKS_CAPABILITY_AUDIENCE } from "./capability"
import { createD1TasksStore } from "./d1-store"
import { createHostedTasksComposition, type HostedTasksCompositionInput } from "./hosted-composition"
import { createHostedTasksSessionBridge } from "./session-bridge"
import { createCloudCreateAdmission } from "../workspace/cloud-create-admission"

// Set before the workspace store's first read: left unset, every root the
// journey allocates would land in the developer's own data directory.
vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")
  process.env.CLAXEDO_DATA_DIR = `${tmp}/claxedo-tasks-hosted-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
})

const runtime = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@claxedo/server-core/workspace/http/workspace-runtime-client", () => ({
  createWorkspaceRuntimeClient: ({ workspace }: { workspace: { id: string } }) => ({
    request: (requestPath: string, init?: RequestInit) => runtime.request(workspace.id, requestPath, init),
  }),
}))

const TASKS = "/api/claxedo/tasks"
const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(["0025_claxedo_tasks.sql", "0026_agent_cross_machine_writes.sql", "0032_task_attachments.sql", "0033_task_child_number.sql"])
  active.push(instance)
  return instance.database
}

/** alice belongs to org-1 and may write project-a; bob belongs to org-2 and may write nothing of alice's. */
const ORGS: Record<string, string> = { alice: "org-1", bob: "org-2" }

/** The sessions the control plane places in each workspace, as the session authority answers for the owner. */
const SESSION_WORKSPACES: Record<string, string> = { ses_1: "ws_root", ses_2: "ws_root", ses_sibling: "ws_sibling" }

type WorkspaceOwner = { userId: string; actorId: string; orgId: string; projectId: string }

/** The cloud root a capability is minted for, a sibling in its project, and one of alice's roots in another project. */
const WORKSPACE_OWNERS: Record<string, WorkspaceOwner> = {
  ws_root: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
  ws_sibling: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
  ws_other: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-b" },
}

const ALICE_PRINCIPAL = { principalKind: "user", actorId: "actor:alice", actorKind: "human" } as const

/**
 * What the authority learns as the journey runs: the roots the bridge
 * creates, owned by alice under the task's project, and the sessions it
 * reserves in them. The fixtures above seed both.
 */
const registry = { owners: new Map<string, WorkspaceOwner>(), placed: new Map<string, string>() }

function plane(sandbox: Record<string, unknown> = {}): HostedControlPlane {
  registry.owners = new Map(Object.entries(WORKSPACE_OWNERS))
  registry.placed = new Map(Object.entries(SESSION_WORKSPACES))
  const sessionAuthority = {
    reserveSession: vi.fn(async () => ({ state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    markSessionRegistrationAmbiguous: vi.fn(async () => ({})),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const createdRoot = (workspaceId: string, orgId: string, projectId: string) => {
    registry.owners.set(workspaceId, { userId: "alice", actorId: "actor:alice", orgId, projectId })
    return { workspace_id: workspaceId }
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" } },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox,
    defaultHomeRegion: "us-east",
    projectionStore: {
      session_metas: vi.fn(async () => new Map()),
      put_session_meta: vi.fn(async () => undefined),
      delete_session_meta: vi.fn(async () => undefined),
    },
    authority: {
      resolveOrgId: vi.fn(async (auth: { user: { subject: string } }) => ORGS[auth.user.subject] ?? "org-unknown"),
      authorizeProject: vi.fn(async (auth: { user: { subject: string } }, args: { projectId: string }) =>
        ORGS[auth.user.subject] === "org-1" && args.projectId === "project-a" ? { ok: true, role: "admin", orgId: "org-1" } : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
      authorizeRuntimeSession: vi.fn(async (input: { actorId: string; sessionId: string; workspaceId: string }) => {
        if (input.actorId !== "actor:alice" || registry.placed.get(input.sessionId) !== input.workspaceId) throw new Error("denied")
      }),
      resolveWorkspaceOwner: vi.fn(async (workspaceId: string) => registry.owners.get(workspaceId)),
      authorizeWorkspaceCreate: vi.fn(async () => undefined),
      createCloudWorkspace: vi.fn(async (auth: { user: { subject: string } }, args: { workspaceId: string; projectId: string }) =>
        createdRoot(args.workspaceId, ORGS[auth.user.subject] ?? "org-unknown", args.projectId),
      ),
      createRuntimeCloudWorkspace: vi.fn(async (_principal: unknown, args: { workspaceId: string; orgId: string; projectId: string }) =>
        createdRoot(args.workspaceId, args.orgId, args.projectId),
      ),
      deleteWorkspace: vi.fn(async () => ({})),
      deleteRuntimeWorkspace: vi.fn(async () => ({})),
      reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: { operationId: string; sessionId: string; workspaceId: string }) => {
        registry.placed.set(intent.sessionId, intent.workspaceId)
        return { ...intent, changed: true, state: "reserved" as const }
      }),
      beginSessionCompensation: vi.fn(async () => ({})),
      completeSessionCompensation: vi.fn(async () => ({})),
      usersMe: vi.fn(async () => ({ user_id: "user-1" })),
      listOrgs: vi.fn(async () => [{ org_id: "org-1" }]),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: createInMemoryCliSessionTokenRegistry(),
    privateSessionAuthority: sessionAuthority,
    runtimeSessionAuthority: sessionAuthority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
  } as unknown as HostedControlPlane
}

/**
 * Start itself belongs to the session bridge, so this one refuses it and
 * reports what the composition handed it instead: the resolver that says which
 * canonical person the request's Tasks actor was minted from. That resolver is
 * the composition's half of reserving a session as its starter, and a stub
 * that ignored it would leave the seam untested on both sides.
 */
function reportingBridge(principal: TasksRuntimePrincipal): TasksSessionBridgePort {
  const refuse = async (actor: TasksActor) => {
    const resolved = await principal(actor)
    return {
      ok: false as const,
      error: { code: "unsupported" as const, message: `principal ${resolved ? resolved.actorId : "absent"}` },
    }
  }
  return {
    async sessionState(origins) {
      return origins.map((origin) => ({ session: origin.sessionRef, state: "unavailable" as const, handoff: "unknown" as const }))
    },
    preview: (command) => refuse(command.actor),
    start: (command) => refuse(command.actor),
    handoff: (command) => refuse(command.actor),
    abandon: (command) => refuse(command.actor),
  }
}

/**
 * Only the two users sign in. A capability the Tasks door refuses falls
 * through to the signed reader, and the default test adapter admits any
 * bearer as a user, which would answer that refusal with a 200.
 */
function knownUsersAuthentication(): RequestAuthenticationAdapter {
  const admitted = testRequestAuthenticationAdapter()
  return {
    descriptor: admitted.descriptor,
    authenticate: async (request) => {
      const bearer = bearerToken(request.headers.get("authorization"))
      if (bearer !== undefined && !(bearer in ORGS)) {
        throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      }
      return await admitted.authenticate(request)
    },
  }
}

async function hostedApp(
  sandbox: Record<string, unknown> = {},
  options: {
    signingEnv?: Record<string, string | undefined>
    passes?: SandboxPassRegister
    authentication?: RequestAuthenticationAdapter
    database?: D1Database
    /** Built against the plane's services, which exist before the app does. */
    bridge?: (services: ControlPlaneServices) => HostedTasksCompositionInput["bridge"]
    cloudSelectedCapabilities?: boolean
  } = {},
) {
  const base = plane(sandbox)
  const authentication = options.authentication ?? testRequestAuthenticationAdapter()
  const tasks = createHostedTasksComposition({
    services: base.services,
    database: options.database ?? (await database()),
    authentication,
    bridge: options.bridge ? options.bridge(base.services) : reportingBridge,
    ...(options.cloudSelectedCapabilities === undefined ? {} : { cloudSelectedCapabilities: options.cloudSelectedCapabilities }),
    ...(options.signingEnv ? { signingEnv: options.signingEnv } : {}),
    ...(options.passes ? { passes: options.passes } : {}),
  })
  const app = createHostedCoreApp(base, {
    authentication,
    liveSyncRoom: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
    serviceCatalog: async () => [],
    cloudWorkspaceAdmission: async () => ({
      status: 403 as const,
      body: { error: { code: "cloud_workspace_capability_unavailable", message: "Capability unavailable" } },
    }),
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    requestGuardExemptions: [],
    userDeployedIdentityAdmission: {
      admit: vi.fn(async (_auth: unknown, input: { identity: { subject: string } }) => ({
        state: "active" as const,
        userId: `user:${input.identity.subject}`,
        actorId: `actor:${input.identity.subject}`,
      })),
    },
    routeContributions: tasks.routeContributions,
  } as unknown as Parameters<typeof createHostedCoreApp>[1]) as unknown as Hono
  return Object.assign(app, { services: base.services })
}

const headers = (subject: string) => ({ authorization: `Bearer ${subject}`, "content-type": "application/json" })

async function presetId(app: Hono, subject: string) {
  const response = await app.request(`https://core.test${TASKS}/presets`, { headers: headers(subject) })
  return ((await response.json()) as { items: [{ id: string }] }).items[0].id
}

async function command(app: Hono, subject: string, clientRequestId: string, body: Record<string, unknown>) {
  const response = await app.request(`https://core.test${TASKS}/commands`, {
    method: "POST",
    headers: headers(subject),
    body: JSON.stringify({ clientRequestId, command: body }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const PRESET = {
  type: "preset.create",
  input: {
    name: "Review the diff",
    instructions: "Read the change before proposing one.",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    agentStartable: false,
    configurations: {
      primary: {
        harness: { id: "claude", access: "native" },
        model: { providerID: "anthropic", modelID: "sonnet" },
        effort: null,
      },
    },
  },
}

const CLOUD_PRESET = {
  ...PRESET,
  input: {
    ...PRESET.input,
    name: "Isolated review",
    execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
  },
}

const TASK = {
  type: "task.create",
  input: { projectId: "project-a", title: "Ship the hosted store", description: "", workspaceId: null, parentTaskId: null },
}

describe("hosted Tasks composition", () => {
  test("refuses an unsigned request", async () => {
    const app = await hostedApp()
    expect((await app.request(`https://core.test${TASKS}/capabilities`)).status).toBe(401)
  })

  // A deployment with no sandbox driver has no isolated root to allocate, so a
  // preset naming cloud placement must be refused when it is saved rather than
  // advertised and then refused at every Start.
  test("answers its capabilities to a signed caller, with no cloud placement on a driverless deployment", async () => {
    const app = await hostedApp()
    const response = await app.request(`https://core.test${TASKS}/capabilities`, { headers: headers("alice") })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      placements: ["local"],
      cloudSelectedCapabilities: false,
    })
    const refused = await command(app, "alice", "request-preset-cloud", CLOUD_PRESET)
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ error: { message: expect.stringContaining("does not support cloud") } })
  })

  test("offers cloud placement once the deployment has a sandbox driver to allocate a root from", async () => {
    const app = await hostedApp({ sandboxManager: { ensure: vi.fn(), target: vi.fn() }, defaultDriver: "daytona" })
    const response = await app.request(`https://core.test${TASKS}/capabilities`, { headers: headers("alice") })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ placements: ["local", "cloud"] })

    // S6 still gates the saved preset: the placement is available, and the
    // selected capability set this host would have to honour is not.
    const refused = await command(app, "alice", "request-preset-cloud", CLOUD_PRESET)
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({
      error: { message: expect.stringContaining("selected cloud capability set") },
    })
  })

  test("commits a preset and a task under the caller's organization and owner", async () => {
    const app = await hostedApp()

    const preset = await command(app, "alice", "request-preset-1", PRESET)
    expect(preset.status).toBe(200)
    expect(preset.body).toMatchObject({
      result: { type: "preset.create", preset: { scopeId: "org-1", ownerId: "alice", name: "Review the diff" } },
    })

    const task = await command(app, "alice", "request-task-1", TASK)
    expect(task.status).toBe(200)
    expect(task.body).toMatchObject({ result: { type: "task.create", task: { scopeId: "org-1", projectId: "project-a" } } })

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(await listed.json()).toMatchObject({ items: [{ title: "Ship the hosted store" }] })
  })

  test("another organization's caller can neither list, read nor write these rows", async () => {
    const app = await hostedApp()
    await command(app, "alice", "request-preset-1", PRESET)
    const created = await command(app, "alice", "request-task-1", TASK)
    const taskId = ((created.body.result as { task: { id: string } }).task).id

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("bob") })
    expect(listed.status).toBe(403)

    // Not 403: the row is outside bob's scope, so it is missing rather than
    // forbidden — a forbidden answer would confirm that this id exists.
    const read = await app.request(`https://core.test${TASKS}/tasks/${taskId}`, { headers: headers("bob") })
    expect(read.status).toBe(404)

    const written = await command(app, "bob", "request-task-2", TASK)
    expect(written.status).toBe(403)

    const presets = await app.request(`https://core.test${TASKS}/presets`, { headers: headers("bob") })
    expect(presets.status).toBe(200)
    expect(await presets.json()).toMatchObject({ items: [] })
  })

  test("hands the session bridge the canonical person the caller's actor was minted from", async () => {
    // The hosted session authority records a creator and grants read access
    // only to that creator, a participant or a share, so a session reserved as
    // the control plane's own service actor would be invisible to the person
    // who started it.
    const app = await hostedApp()
    await command(app, "alice", "request-preset-1", PRESET)
    const created = await command(app, "alice", "request-task-1", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: headers("alice"),
      body: JSON.stringify({
        taskRevision: 1,
        presetId: (await presetId(app, "alice")),
        presetRevision: 1,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    expect(await preview.json()).toMatchObject({ error: { message: "principal actor:alice" } })
  })

  test("a repeated client request id replays the committed result instead of committing twice", async () => {
    const app = await hostedApp()
    const first = await command(app, "alice", "request-task-1", TASK)
    const again = await command(app, "alice", "request-task-1", TASK)
    expect(again.body).toMatchObject({ replayed: true })
    expect((again.body.result as { task: { id: string } }).task.id).toBe((first.body.result as { task: { id: string } }).task.id)

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)
  })
})

/**
 * The same composition reached by the other credential it accepts: a
 * capability this control plane minted for one cloud root, presented by that
 * root's sessions. The routes, the store and the authority are the real ones;
 * what the tests pin is who the request turns out to be and what it may do.
 */
describe("hosted Tasks capability", () => {
  async function signing() {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    return {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
  }

  const grant = (
    signingEnv: Record<string, string | undefined>,
    scope: Partial<Parameters<typeof mintTasksCapability>[0]> = {},
  ) => mintTasksCapability(
    {
      userId: "alice",
      orgId: "org-1",
      projectId: "project-a",
      workspaceId: "ws_root",
      sessionId: "ses_1",
      operations: ["read", "create", "start"],
      ...scope,
    },
    signingEnv,
  )

  /** A cloud root's own grant, minted for the root rather than for any one session. */
  const rootGrant = (signingEnv: Record<string, string | undefined>) =>
    mintTasksCapability(
      { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", operations: ["read", "create", "start"] },
      signingEnv,
    )

  const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })

  test("reads and writes the project of its own workspace", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)

    const created = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ clientRequestId: "agent-1", command: TASK }),
    })
    expect(created.status).toBe(200)

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)
  })

  test("writes into the organization the workspace's owner belongs to, so the owner reads them back", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ clientRequestId: "agent-1", command: TASK }),
    })

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(((await listed.json()) as { items: [{ title: string }] }).items[0].title).toBe(TASK.input.title)
  })

  test("is refused once the register has revoked it, with nothing left to fall through to", async () => {
    const signingEnv = await signing()
    const passes = memorySandboxPassRegister()
    const app = await hostedApp({}, { signingEnv, passes, authentication: knownUsersAuthentication() })
    const { token } = await mintTasksCapability(
      { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", operations: ["read"] },
      signingEnv,
      { register: passes },
    )
    expect((await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })).status).toBe(200)

    await passes.revoke({ workspaceId: "ws_root", audience: TASKS_CAPABILITY_AUDIENCE, reason: "tasks_group_disabled" })
    const refused = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { message: "This request is not signed" } })
  })

  test("is refused when the workspace's owner is not the user the token names", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv, { userId: "bob" })
    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(listed.status).toBe(403)
    expect(await listed.json()).toMatchObject({ error: { message: expect.stringContaining("no longer answers") } })
  })

  test("is refused for a workspace this control plane does not know", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv, { workspaceId: "ws_elsewhere" })
    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(listed.status).toBe(403)
  })

  test("is refused for a project that is not the scope's", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-b`, { headers: bearer(token) })
    expect(listed.status).toBe(403)
    expect(await listed.json()).toMatchObject({ error: { message: expect.stringContaining("project-a") } })

    const created = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        clientRequestId: "agent-2",
        command: { ...TASK, input: { ...TASK.input, projectId: "project-b" } },
      }),
    })
    expect(created.status).toBe(403)
  })

  test("may prefer a workspace of its own project for a task, and no other", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    const create = (clientRequestId: string, workspaceId: string | null) =>
      app.request(`https://core.test${TASKS}/commands`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ clientRequestId, command: { ...TASK, input: { ...TASK.input, workspaceId } } }),
      })

    expect((await create("agent-own", "ws_root")).status).toBe(200)
    expect((await create("agent-sibling", "ws_sibling")).status).toBe(200)

    for (const [clientRequestId, workspaceId] of [["agent-other-project", "ws_other"], ["agent-unknown", "ws_elsewhere"]]) {
      const refused = await create(clientRequestId, workspaceId)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { message: "This session may act only in project project-a" } })
    }

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    const preferred = ((await listed.json()) as { items: { workspaceId: string | null }[] }).items.map((item) => item.workspaceId)
    expect(new Set(preferred)).toEqual(new Set(["ws_root", "ws_sibling"]))
  })

  test("may record only itself as a task's provenance", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    const create = (clientRequestId: string, createdFrom: { workspaceId: string | null; sessionId: string }) =>
      app.request(`https://core.test${TASKS}/commands`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ clientRequestId, command: { ...TASK, input: { ...TASK.input, createdFrom } } }),
      })

    const own = await create("agent-own", { workspaceId: "ws_root", sessionId: "ses_1" })
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({
      result: { task: { createdFrom: { workspaceId: "ws_root", sessionId: "ses_1" } } },
    })

    const forged = await create("agent-forged", { workspaceId: "ws_victim", sessionId: "ses_victim" })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toMatchObject({
      error: { message: "This session may record only itself as a task's provenance" },
    })

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)
  })

  test("minted for a root, records as provenance a session the control plane places in that root", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await rootGrant(signingEnv)
    const create = (clientRequestId: string, createdFrom: { workspaceId: string | null; sessionId: string }) =>
      app.request(`https://core.test${TASKS}/commands`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ clientRequestId, command: { ...TASK, input: { ...TASK.input, createdFrom } } }),
      })

    const own = await create("root-own", { workspaceId: "ws_root", sessionId: "ses_2" })
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({ result: { task: { createdFrom: { workspaceId: "ws_root", sessionId: "ses_2" } } } })

    for (const [clientRequestId, forged] of [
      ["root-sibling", { workspaceId: "ws_sibling", sessionId: "ses_sibling" }],
      ["root-elsewhere", { workspaceId: "ws_root", sessionId: "ses_sibling" }],
      ["root-stranger", { workspaceId: "ws_root", sessionId: "ses_stranger" }],
    ] as const) {
      const refused = await create(clientRequestId, forged)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({
        error: { message: "This session may record only a session of its own workspace as provenance" },
      })
    }

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    const items = ((await listed.json()) as { items: { createdFrom: unknown }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.createdFrom).toEqual({ workspaceId: "ws_root", sessionId: "ses_2" })
  })

  test("minted for a root, names the calling session at Start only when the control plane places it in that root", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await rootGrant(signingEnv)
    await command(app, "alice", "owner-preset", { ...PRESET, input: { ...PRESET.input, agentStartable: true } })
    const created = await command(app, "alice", "owner-task", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id
    const preview = async (startedFrom: { workspaceId: string | null; sessionId: string }) =>
      app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({
          taskRevision: 1,
          presetId: await presetId(app, "alice"),
          presetRevision: 1,
          slot: "primary",
          attempt: 1,
          continueFromPrevious: false,
          startedFrom,
        }),
      })

    // The stub bridge refuses every Start naming the principal it was handed,
    // so its sentence is the proof the provenance was admitted.
    expect(await (await preview({ workspaceId: "ws_root", sessionId: "ses_2" })).json()).toMatchObject({
      error: { message: "principal actor:alice" },
    })
    const forged = await preview({ workspaceId: "ws_root", sessionId: "ses_sibling" })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toMatchObject({
      error: { message: "This session may record only a session of its own workspace as provenance" },
    })
  })

  test("cannot start a task the owner pointed at another project's workspace", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    await command(app, "alice", "owner-preset", PRESET)
    const created = await command(app, "alice", "owner-task", {
      ...TASK,
      input: { ...TASK.input, workspaceId: "ws_other" },
    })
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        taskRevision: 1,
        presetId: await presetId(app, "alice"),
        presetRevision: 1,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    // The stub bridge names the principal it was handed; a refusal in its
    // words would mean the Start reached it.
    expect(preview.status).toBe(403)
    expect(await preview.json()).toMatchObject({ error: { message: "This session may act only in project project-a" } })
  })

  test("is refused an operation its scope does not carry", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv, { operations: ["read"] })

    const created = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ clientRequestId: "agent-3", command: TASK }),
    })
    expect(created.status).toBe(403)
    expect(await created.json()).toMatchObject({ error: { message: expect.stringContaining("does not allow create") } })

    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(listed.status).toBe(200)
  })

  test("is refused every command but creating a task, whatever it was granted", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    const created = await command(app, "alice", "owner-task", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const archived = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        clientRequestId: "agent-4",
        command: { type: "task.archive", input: { taskId, revision: 1 } },
      }),
    })
    expect(archived.status).toBe(403)
    expect(await archived.json()).toMatchObject({ error: { message: expect.stringContaining("cannot reach this command") } })
  })

  test("is refused a preset nobody marked for agents before the bridge is reached", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    await command(app, "alice", "owner-preset", PRESET)
    const created = await command(app, "alice", "owner-task", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        taskRevision: 1,
        presetId: await presetId(app, "alice"),
        presetRevision: 1,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    expect(preview.status).toBe(403)
    expect(await preview.json()).toMatchObject({
      error: { message: "Preset Review the diff is not marked as startable by agents; a person can mark it in Settings → Presets" },
    })
  })

  test("reaches Start as the workspace's owner", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(signingEnv)
    await command(app, "alice", "owner-preset", { ...PRESET, input: { ...PRESET.input, agentStartable: true } })
    const created = await command(app, "alice", "owner-task", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        taskRevision: 1,
        presetId: await presetId(app, "alice"),
        presetRevision: 1,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    // The stub bridge refuses every Start and reports the principal it was
    // handed, which is what says the session this would reserve belongs to the
    // workspace's owner rather than to the agent that asked.
    expect(await preview.json()).toMatchObject({ error: { message: "principal actor:alice" } })
  })

  test("is refused by a deployment that mints none", async () => {
    const signingEnv = await signing()
    const app = await hostedApp()
    const { token } = await grant(signingEnv)
    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    // Not a capability refusal: a plane that mints none reads the bearer as a
    // signed token, and the project the grant named is one that stranger has
    // no access to.
    expect(listed.status).toBe(403)
    expect(await listed.json()).toMatchObject({ error: { message: "No read access to project project-a" } })
  })

  test("is refused when another key signed it", async () => {
    const signingEnv = await signing()
    const app = await hostedApp({}, { signingEnv })
    const { token } = await grant(await signing())
    const listed = await app.request(`https://core.test${TASKS}/tasks?projectId=project-a`, { headers: bearer(token) })
    expect(listed.status).toBe(403)
    expect(await listed.json()).toMatchObject({ error: { message: "No read access to project project-a" } })
  })
})

/**
 * The whole path a hosted session's agent takes to a cloud machine, through
 * the real routes, the real D1 store, the real hosted bridge, the real
 * workspace store and the real sandbox manager over a fake driver. The
 * authority is the fixture above, which learns each root the bridge creates.
 */
describe("hosted Tasks cloud start from inside a session", () => {
  const PROJECT_REPO = "https://github.com/acme/importer.git"
  const HARNESS = { id: "claude", access: "native" as const }
  const MODEL = { providerID: "anthropic", modelID: "sonnet" }

  async function signing() {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    return {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
  }

  /** The endpoints a Start touches, answered per workspace so two roots cannot read each other's sessions. */
  function fakeRuntime() {
    type Message = { info: { id: string; role: string; sessionID: string }; parts: unknown[] }
    const sessions = new Map<string, Map<string, Message[]>>()
    runtime.request.mockImplementation(async (workspaceId: string, requestPath: string, init?: RequestInit) => {
      const rows = sessions.get(workspaceId) ?? new Map<string, Message[]>()
      sessions.set(workspaceId, rows)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      if (requestPath.startsWith("/session/capabilities")) {
        return Response.json({
          harness: HARNESS.id,
          modelSelection: { status: "optional", models: [{ providerId: MODEL.providerID, modelId: MODEL.modelID, name: "Sonnet" }] },
        })
      }
      if (requestPath.startsWith("/session?")) {
        rows.set(String(body.id), [])
        return Response.json({ id: String(body.id), directory: "/workspace" }, { status: 201 })
      }
      const message = /^\/session\/([^/]+)\/message$/.exec(requestPath)
      if (message) {
        const messages = rows.get(message[1])
        return messages ? Response.json(messages) : Response.json({}, { status: 404 })
      }
      const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(requestPath)
      if (prompt) {
        const messages = rows.get(prompt[1])
        if (!messages) return Response.json({}, { status: 404 })
        const messageID = String(body.messageID)
        const parts = Array.isArray(body.parts) ? body.parts : []
        messages.push({
          info: { id: messageID, role: "user", sessionID: prompt[1] },
          parts: parts.map((part, index) => ({ ...(typeof part === "object" && part ? part : {}), id: `prt_${messageID}_${index}`, sessionID: prompt[1], messageID })),
        })
        return new Response(null, { status: 204 })
      }
      const config = /^\/session\/([^/]+)\/config$/.exec(requestPath)
      if (config) {
        return rows.has(config[1])
          ? Response.json({ harness: HARNESS, model: MODEL, variant: null, instructions: "" })
          : Response.json({}, { status: 404 })
      }
      const read = /^\/session\/([^/]+)$/.exec(requestPath)
      if (read) return rows.has(read[1]) ? Response.json({ id: read[1] }) : Response.json({}, { status: 404 })
      return Response.json({ error: { code: "unexpected", message: requestPath } }, { status: 500 })
    })
  }

  function fakeDriver() {
    const ensured = new Set<string>()
    const driver: SandboxDriver = {
      id: "test-driver",
      metadata: {
        driverRunsIn: ["node"],
        hostStopBehavior: "suspends-host",
        hostResumeBehavior: "same-host",
        targetAccess: "relay",
        secretBrokering: "none",
        egressControl: "hosts-and-cidrs",
        persistence: {
          resume: "same-sandbox",
          capture: "none",
          clone: false,
          captureSource: "not-applicable",
          retention: "not-applicable",
          restoreMount: "not-applicable",
        },
      },
      ensureHost: async (input) => {
        ensured.add(input.workspaceId)
        return {
          sandboxId: `sandbox_${input.workspaceId}`,
          url: `https://runtime.test/${input.workspaceId}`,
          hostId: `host_${input.workspaceId}`,
          labels: input.labels,
        }
      },
    }
    return { driver, ensured }
  }

  beforeEach(async () => {
    fakeRuntime()
    for (const workspace of await listWorkspaces()) await deleteWorkspace(workspace.id)
    await ensureWorkspace({
      workspaceId: "project-a",
      project_id: "project-a",
      project_name: "importer",
      workspace_name: "importer",
      directory: "/workspace",
      kind: "cloud",
      driver: "daytona",
      repo_url: PROJECT_REPO,
      git_branch: "main",
      remote_directory: "/workspace",
    })
  })

  const startBody = (presetId: string, startedFrom?: { workspaceId: string; sessionId: string }) => ({
    taskRevision: 1,
    presetId,
    presetRevision: 1,
    slot: "primary",
    attempt: 1,
    continueFromPrevious: false,
    ...(startedFrom ? { startedFrom } : {}),
  })

  test("a root's agent starts a cloud task as the owner, and the chain stops one machine later", async () => {
    const signingEnv = await signing()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const rootEnvironment = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "root-grant" }))
    const controlPlane = await database()
    const app = await hostedApp(
      { sandboxManager, defaultDriver: "daytona" },
      {
        signingEnv,
        database: controlPlane,
        cloudSelectedCapabilities: true,
        bridge: (services) => (principal, auth, owner) =>
          createHostedTasksSessionBridge({
            services,
            runtimeClient: {},
            principal,
            auth,
            owner,
            selectedCapabilities: { prepare: async () => ({}), apply: async () => undefined },
            capability: rootEnvironment,
            sandboxEgress: { controlPlaneOrigin: "https://cp.test" },
          }),
      },
    )
    const authority = app.services.authority as unknown as Record<string, ReturnType<typeof vi.fn>>
    const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })
    const rootGrant = (workspaceId: string, sessionId?: string) =>
      mintTasksCapability(
        {
          userId: "alice",
          orgId: "org-1",
          projectId: "project-a",
          workspaceId,
          ...(sessionId ? { sessionId } : {}),
          operations: ["read", "create", "start"],
        },
        signingEnv,
      )

    const preset = await command(app, "alice", "owner-preset", {
      ...CLOUD_PRESET,
      input: { ...CLOUD_PRESET.input, agentStartable: true },
    })
    expect(preset.status).toBe(200)
    const cloudPresetId = (preset.body.result as { preset: { id: string } }).preset.id

    // The root's own grant, minted for no one session, creates a task from a
    // session the plane places in that root and starts it from there.
    const { token: rootToken } = await rootGrant("ws_root")
    const created = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(rootToken),
      body: JSON.stringify({
        clientRequestId: "root-create",
        command: { ...TASK, input: { ...TASK.input, createdFrom: { workspaceId: "ws_root", sessionId: "ses_2" } } },
      }),
    })
    expect(created.status).toBe(200)
    const taskB = ((await created.json()) as { result: { task: { id: string } } }).result.task.id
    const startedFrom = { workspaceId: "ws_root", sessionId: "ses_2" }

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskB}/start-preview`, {
      method: "POST",
      headers: bearer(rootToken),
      body: JSON.stringify(startBody(cloudPresetId, startedFrom)),
    })
    expect(preview.status).toBe(200)
    const previewed = ((await preview.json()) as { preview: { digest: string; available: boolean; blockers: unknown[]; placement: string } }).preview
    expect(previewed).toMatchObject({ available: true, blockers: [], placement: "cloud" })

    const started = await app.request(`https://core.test${TASKS}/tasks/${taskB}/sessions`, {
      method: "POST",
      headers: bearer(rootToken),
      body: JSON.stringify({ ...startBody(cloudPresetId, startedFrom), clientRequestId: "root-start", previewDigest: previewed.digest, handoffText: null }),
    })
    const link = ((await started.json()) as { created: boolean; link: { sessionRef: { sessionId: string; workspaceId: string } } })
    expect({ status: started.status, body: link }).toMatchObject({ status: 200, body: { created: true } })
    const rootB = link.link.sessionRef.workspaceId
    expect(rootB).toMatch(/^ws_[0-9a-f]{24}$/)

    // Created as the owner's canonical actor through the runtime-principal
    // path, never through the signed one, and reserved as the same actor.
    expect(authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect(authority.createRuntimeCloudWorkspace).toHaveBeenCalledWith(
      ALICE_PRINCIPAL,
      expect.objectContaining({ workspaceId: rootB, orgId: "org-1", projectId: "project-a", repoUrl: PROJECT_REPO }),
    )
    expect(authority.reserveRuntimeSession).toHaveBeenCalledWith(
      ALICE_PRINCIPAL,
      expect.objectContaining({ sessionId: link.link.sessionRef.sessionId, workspaceId: rootB }),
    )
    expect(rootEnvironment).toHaveBeenCalledWith({ userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: rootB })
    expect([...ensured]).toEqual([rootB])
    // Preview and Start each re-admit the one root; neither creates a second.
    const admissions = () =>
      (authority.createRuntimeCloudWorkspace.mock.calls as [unknown, { workspaceId: string }][]).map(([, args]) => args.workspaceId)
    expect(new Set(admissions())).toEqual(new Set([rootB]))
    const admittedBeforeHop = admissions().length

    // The link says an agent started it, from the session it named, on a
    // cloud machine — which is what the per-project cap counts.
    const links = await createD1TasksStore({ database: controlPlane }).links.listAgentStartedCloud("org-1", "project-a")
    expect(links).toMatchObject([
      { taskId: taskB, startedBy: "agent", placement: "cloud", startedFrom, sessionRef: link.link.sessionRef },
    ])

    // The new root's own session creates a task and asks to start it: two
    // machines from the person, and refused before anything is allocated.
    const { token: hopToken } = await rootGrant(rootB, link.link.sessionRef.sessionId)
    const chained = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer(hopToken),
      body: JSON.stringify({
        clientRequestId: "hop-create",
        command: { ...TASK, input: { ...TASK.input, title: "Two hops out", createdFrom: link.link.sessionRef } },
      }),
    })
    expect(chained.status).toBe(200)
    const taskC = ((await chained.json()) as { result: { task: { id: string } } }).result.task.id

    const refused = await app.request(`https://core.test${TASKS}/tasks/${taskC}/start-preview`, {
      method: "POST",
      headers: bearer(hopToken),
      body: JSON.stringify(startBody(cloudPresetId, link.link.sessionRef)),
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      error: { message: `Task ${taskC} is two machines away from the person who started this chain; start it from the app` },
    })
    expect(admissions()).toHaveLength(admittedBeforeHop)
    expect([...ensured]).toEqual([rootB])
  })

  test("the deployment's create admission answers a grant-minted start before a root exists", async () => {
    const signingEnv = await signing()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    // The same object the workspace create route would build from its
    // entitlement option, handed to the bridge — the gate is asked for the
    // owner the grant resolved to, because a grant has no bearer to sign with.
    const entitlement = vi.fn(async (tenant: { orgId?: string }) => ({
      status: 402 as const,
      body: { error: { code: "billing_entitlement_required", message: `no cloud-workspace for ${tenant.orgId}` } },
    }))
    const app = await hostedApp(
      { sandboxManager, defaultDriver: "daytona" },
      {
        signingEnv,
        database: await database(),
        cloudSelectedCapabilities: true,
        bridge: (services) => (principal, auth, owner) =>
          createHostedTasksSessionBridge({
            services,
            runtimeClient: {},
            principal,
            auth,
            owner,
            selectedCapabilities: { prepare: async () => ({}), apply: async () => undefined },
            cloudCreateAdmission: createCloudCreateAdmission({ services, entitlement }),
            sandboxEgress: { controlPlaneOrigin: "https://cp.test" },
          }),
      },
    )
    const authority = app.services.authority as unknown as Record<string, ReturnType<typeof vi.fn>>
    const { token: rootToken } = await mintTasksCapability(
      {
        userId: "alice",
        orgId: "org-1",
        projectId: "project-a",
        workspaceId: "ws_root",
        sessionId: "ses_2",
        operations: ["read", "create", "start"],
      },
      signingEnv,
    )
    const bearer = { authorization: `Bearer ${rootToken}`, "content-type": "application/json" }
    const preset = await command(app, "alice", "owner-preset", {
      ...CLOUD_PRESET,
      input: { ...CLOUD_PRESET.input, agentStartable: true },
    })
    expect(preset.status).toBe(200)
    const cloudPresetId = (preset.body.result as { preset: { id: string } }).preset.id
    const created = await app.request(`https://core.test${TASKS}/commands`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        clientRequestId: "owner-task",
        command: { ...TASK, input: { ...TASK.input, createdFrom: { workspaceId: "ws_root", sessionId: "ses_2" } } },
      }),
    })
    expect(created.status).toBe(200)
    const taskId = (((await created.json()) as { result: { task: { id: string } } }).result.task).id

    const preview = await app.request(`https://core.test${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify(startBody(cloudPresetId, { workspaceId: "ws_root", sessionId: "ses_2" })),
    })
    expect(preview.status).toBe(200)
    const previewed = ((await preview.json()) as { preview: { available: boolean; blockers: unknown[] } }).preview
    expect(previewed).toMatchObject({
      available: false,
      blockers: [{ code: "source_unavailable", detail: "no cloud-workspace for org-1" }],
    })
    expect(entitlement).toHaveBeenCalledWith({ orgId: "org-1" })
    expect(authority.createRuntimeCloudWorkspace).not.toHaveBeenCalled()
    expect(authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect([...ensured]).toEqual([])
  })
})
