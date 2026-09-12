/**
 * Tasks through the real hosted app, with the real signed-request path and the
 * real D1 schema. What is stubbed is the session bridge, because Start is the
 * one thing in this feature that is not this composition's: everything the
 * test asserts — who the caller is, which organization their rows belong to,
 * and what the authority lets them reach — is decided before the bridge is
 * ever consulted.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import type { TasksActor, TasksSessionBridgePort } from "@claxedo/tasks"
import type { TasksRuntimePrincipal } from "@claxedo/server-core/tasks-host/authorization"

import { createHostedCoreApp } from "../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../authority/hosted-services"
import type { ControlPlaneServices } from "../authority/services"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"
import { createHostedTasksComposition } from "./hosted-composition"

const TASKS = "/api/claxedo/tasks"
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  const path = fileURLToPath(new URL("../../migrations/control-plane/0024_claxedo_tasks.sql", import.meta.url))
  const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    await target.prepare(statement).run()
  }
  return target
}

/** alice belongs to org-1 and may write project-a; bob belongs to org-2 and may write nothing of alice's. */
const ORGS: Record<string, string> = { alice: "org-1", bob: "org-2" }

function plane(): HostedControlPlane {
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
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async (auth: { user: { subject: string } }) => ORGS[auth.user.subject] ?? "org-unknown"),
      authorizeProject: vi.fn(async (auth: { user: { subject: string } }, args: { projectId: string }) =>
        ORGS[auth.user.subject] === "org-1" && args.projectId === "project-a" ? { ok: true, role: "admin", orgId: "org-1" } : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
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
    async sessionState(sessions) {
      return sessions.map((session) => ({ session, state: "unavailable" as const }))
    },
    preview: (command) => refuse(command.actor),
    start: (command) => refuse(command.actor),
    handoff: (command) => refuse(command.actor),
  }
}

async function hostedApp() {
  const base = plane()
  const authentication = testRequestAuthenticationAdapter()
  const tasks = createHostedTasksComposition({
    services: base.services,
    database: await database(),
    authentication,
    bridge: reportingBridge,
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

const TASK = {
  type: "task.create",
  input: { projectId: "project-a", title: "Ship the hosted store", description: "", workspaceId: null, parentTaskId: null },
}

describe("hosted Tasks composition", () => {
  test("refuses an unsigned request", async () => {
    const app = await hostedApp()
    expect((await app.request(`https://core.test${TASKS}/capabilities`)).status).toBe(401)
  })

  // The bridge refuses cloud placement on every host, so a preset naming one
  // must be refused when it is saved rather than advertised and then refused
  // at Start.
  test("answers its capabilities to a signed caller, with no cloud placement", async () => {
    const app = await hostedApp()
    const response = await app.request(`https://core.test${TASKS}/capabilities`, { headers: headers("alice") })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      placements: ["local"],
      cloudSelectedCapabilities: false,
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
