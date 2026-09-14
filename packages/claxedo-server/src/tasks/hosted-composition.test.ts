/**
 * Tasks through the real hosted app, with the real signed-request path and the
 * real D1 schema. What is stubbed is the session bridge, because Start is the
 * one thing in this feature that is not this composition's: everything the
 * test asserts — who the caller is, which organization their rows belong to,
 * and what the authority lets them reach — is decided before the bridge is
 * ever consulted.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { Hono } from "hono"
import type { D1Database } from "@cloudflare/workers-types"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
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
import { mintTasksCapability } from "./capability"
import { createHostedTasksComposition } from "./hosted-composition"

const TASKS = "/api/claxedo/tasks"
const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(["0024_claxedo_tasks.sql"])
  active.push(instance)
  return instance.database
}

/** alice belongs to org-1 and may write project-a; bob belongs to org-2 and may write nothing of alice's. */
const ORGS: Record<string, string> = { alice: "org-1", bob: "org-2" }

/** The cloud root a capability is minted for, a sibling in its project, and one of alice's roots in another project. */
const WORKSPACE_OWNERS: Record<string, { userId: string; actorId: string; orgId: string; projectId: string }> = {
  ws_root: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
  ws_sibling: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
  ws_other: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-b" },
}

function plane(sandbox: Record<string, unknown> = {}): HostedControlPlane {
  const sessionAuthority = {
    reserveSession: vi.fn(async () => ({ state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    markSessionRegistrationAmbiguous: vi.fn(async () => ({})),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" } },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox,
    authority: {
      resolveOrgId: vi.fn(async (auth: { user: { subject: string } }) => ORGS[auth.user.subject] ?? "org-unknown"),
      authorizeProject: vi.fn(async (auth: { user: { subject: string } }, args: { projectId: string }) =>
        ORGS[auth.user.subject] === "org-1" && args.projectId === "project-a" ? { ok: true, role: "admin", orgId: "org-1" } : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
      resolveWorkspaceOwner: vi.fn(async (workspaceId: string) => WORKSPACE_OWNERS[workspaceId]),
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

async function hostedApp(
  sandbox: Record<string, unknown> = {},
  options: { signingEnv?: Record<string, string | undefined> } = {},
) {
  const base = plane(sandbox)
  const authentication = testRequestAuthenticationAdapter()
  const tasks = createHostedTasksComposition({
    services: base.services,
    database: await database(),
    authentication,
    bridge: reportingBridge,
    ...(options.signingEnv ? { signingEnv: options.signingEnv } : {}),
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
  return app
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

  test("reaches Start as the workspace's owner", async () => {
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
