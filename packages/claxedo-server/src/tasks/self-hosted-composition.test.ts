/**
 * The signed self-hosted composition over the real SQLite store and the real
 * signed-request reader. Only the embedded issuer's token verification and the
 * workspace authority's answers are fixtures: everything asserted here — which
 * organization a caller's rows land in, who owns them, and what a caller from
 * another organization can reach — is decided by this composition and the kit.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { betterAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import type { TasksCapabilityOwner } from "@claxedo/server-core/tasks-host/capability"
import type { ControlPlaneServices } from "../authority/services"
import { createSelfHostedTasksComposition } from "./self-hosted-composition"
import { createTasksSessionGrants } from "./session-grants"

const bridgeInputs = vi.hoisted(() => [] as unknown[])
vi.mock("@claxedo/local-server/tasks/session-bridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("@claxedo/local-server/tasks/session-bridge")>()
  return {
    ...original,
    createLocalTasksSessionBridge: (input?: unknown) => {
      bridgeInputs.push(input)
      return original.createLocalTasksSessionBridge(input as Parameters<typeof original.createLocalTasksSessionBridge>[0])
    },
  }
})

const TASKS = "/api/claxedo/tasks"
const ORIGIN = "http://box.example"
const LOOPBACK = "http://127.0.0.1:4096"

/** alice belongs to org-1 and may write project-a; bob belongs to org-2 and may write nothing of alice's. */
const ORGS: Record<string, string> = { alice: "org-1", bob: "org-2" }

let dataDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-tasks-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE"]) saved[key] = process.env[key]
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
})

afterEach(() => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function services(): ControlPlaneServices {
  return {
    // The self-host's signed posture: the embedded Better Auth issuer's bearer
    // verifier, which is what `createDefaultLocalControlPlaneServices` composes
    // when CLAXEDO_EMBEDDED_AUTH is on.
    auth: betterAuthAdapter({
      issuer: "claxedo-embedded",
      verifier: async (token) =>
        token in ORGS ? { subject: token, tokenIdentifier: `session:${token}`, issuer: "claxedo-embedded" } : null,
    }),
    authority: {
      resolveOrgId: vi.fn(async (auth: { user: { subject: string } }) => ORGS[auth.user.subject] ?? "org-unknown"),
      authorizeProject: vi.fn(async (auth: { user: { subject: string } }, args: { projectId: string }) =>
        ORGS[auth.user.subject] === "org-1" && args.projectId === "project-a"
          ? { ok: true, role: "admin", orgId: "org-1" }
          : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
    },
    telemetry: { capture: vi.fn() },
    relay: {},
    sandbox: {},
    localExecution: { enabled: true },
  } as unknown as ControlPlaneServices
}

function app() {
  const bare = new Hono()
  mountControlPlaneRouteContributions({
    contributions: createSelfHostedTasksComposition({ services: services() }).routeContributions,
    mount: (contribution) => bare.route(contribution.path, contribution.routes),
  })
  return bare
}

const headers = (subject: string) => ({ authorization: `Bearer ${subject}`, "content-type": "application/json" })

async function command(target: Hono, subject: string, clientRequestId: string, body: Record<string, unknown>) {
  const response = await target.request(`${ORIGIN}${TASKS}/commands`, {
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

const TASK = {
  type: "task.create",
  input: { projectId: "project-a", title: "Ship the signed self-host", description: "", workspaceId: null, parentTaskId: null },
}

describe("signed self-hosted Tasks composition", () => {
  test("answers its capabilities to a signed caller", async () => {
    const response = await app().request(`${ORIGIN}${TASKS}/capabilities`, { headers: headers("alice") })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      placements: ["local"],
      cloudSelectedCapabilities: false,
    })
  })

  test("commits a preset and a task under the caller's own organization and owner", async () => {
    const target = app()

    const preset = await command(target, "alice", "request-preset-1", PRESET)
    expect(preset.status).toBe(200)
    expect(preset.body).toMatchObject({
      result: { type: "preset.create", preset: { scopeId: "org-1", ownerId: "alice", name: "Review the diff" } },
    })

    const task = await command(target, "alice", "request-task-1", TASK)
    expect(task.status).toBe(200)
    expect(task.body).toMatchObject({ result: { type: "task.create", task: { scopeId: "org-1", projectId: "project-a" } } })

    const listed = await target.request(`${ORIGIN}${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(await listed.json()).toMatchObject({ items: [{ title: "Ship the signed self-host" }] })
  })

  test("a signed caller from another organization can neither list, read nor write these rows", async () => {
    const target = app()
    await command(target, "alice", "request-preset-1", PRESET)
    const created = await command(target, "alice", "request-task-1", TASK)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    expect((await target.request(`${ORIGIN}${TASKS}/tasks?projectId=project-a`, { headers: headers("bob") })).status).toBe(403)

    // Not 403: the row is outside bob's scope, so it is missing rather than
    // forbidden — a forbidden answer would confirm that this id exists.
    expect((await target.request(`${ORIGIN}${TASKS}/tasks/${taskId}`, { headers: headers("bob") })).status).toBe(404)

    expect((await command(target, "bob", "request-task-2", TASK)).status).toBe(403)

    const presets = await target.request(`${ORIGIN}${TASKS}/presets`, { headers: headers("bob") })
    expect(presets.status).toBe(200)
    expect(await presets.json()).toMatchObject({ items: [] })
  })

  test("refuses an unsigned loopback request instead of admitting it as a local owner", async () => {
    const target = app()
    expect((await target.request(`${LOOPBACK}${TASKS}/capabilities`)).status).toBe(401)
    expect((await target.request(`${ORIGIN}${TASKS}/capabilities`)).status).toBe(401)
  })

  test("refuses a bearer token the issuer does not recognise", async () => {
    const response = await app().request(`${ORIGIN}${TASKS}/capabilities`, { headers: headers("carol") })
    expect(response.status).toBe(401)
  })

  test("hands the local bridge a reservation bound to the signed caller, never the service actor", async () => {
    const intent = {
      actor: { scopeId: "org-unknown", ownerId: "nobody" },
      operationId: "tasks.v1:org-unknown:tsk:primary:1:digest",
      sessionId: "ses_tasks_test",
      workspaceId: "ws-1",
      title: "t",
    }
    type Reserve = (intent: unknown) => Promise<{ ok: boolean; error?: { code: string } }>
    const reserveOf = () => (bridgeInputs[bridgeInputs.length - 1] as { reserve?: Reserve }).reserve

    createSelfHostedTasksComposition({ services: services() })
    expect(typeof reserveOf()).toBe("function")
    const withoutRegistration = await reserveOf()!(intent)
    expect(withoutRegistration.ok).toBe(false)
    expect(withoutRegistration.error?.code).toBe("unsupported")

    const base = services()
    const reserveRuntimeSession = vi.fn()
    createSelfHostedTasksComposition({
      services: { ...base, authority: { ...base.authority, reserveRuntimeSession } } as ControlPlaneServices,
    })
    const withRegistration = await reserveOf()!(intent)
    expect(withRegistration.ok).toBe(false)
    expect(withRegistration.error?.code).toBe("forbidden")
    expect(reserveRuntimeSession).not.toHaveBeenCalled()
  })

  test("hands the local bridge the undo of that reservation, so a session it admitted can be given back", async () => {
    type Release = (input: unknown) => Promise<void>
    const releaseOf = () => (bridgeInputs[bridgeInputs.length - 1] as { release?: Release }).release

    const base = services()
    const beginSessionCompensation = vi.fn(async () => ({}))
    const completeSessionCompensation = vi.fn(async () => ({}))
    createSelfHostedTasksComposition({
      services: {
        ...base,
        authority: { ...base.authority, beginSessionCompensation, completeSessionCompensation },
      } as unknown as ControlPlaneServices,
    })
    expect(typeof releaseOf()).toBe("function")

    // The signed caller is the one the reservation recorded, so an actor this
    // host cannot resolve releases nothing rather than releasing as the
    // service actor.
    await releaseOf()!({
      actor: { scopeId: "org-unknown", ownerId: "nobody" },
      operationId: "tasks.v1:org-unknown:tsk:primary:1:digest",
      sessionId: "ses_tasks_test",
      workspaceId: "ws-1",
      reason: "never linked",
    })
    expect(beginSessionCompensation).not.toHaveBeenCalled()
    expect(completeSessionCompensation).not.toHaveBeenCalled()
  })

  test("a session's grant cannot start a task the owner pointed at another project's workspace", async () => {
    const alice = { userId: "alice", actorId: "actor:alice", orgId: "org-1" }
    const owners: Record<string, TasksCapabilityOwner> = {
      ws_root: { ...alice, projectId: "project-a" },
      ws_other: { ...alice, projectId: "project-b" },
    }
    const grants = createTasksSessionGrants({ workspaceOwner: async (workspaceId) => owners[workspaceId] })
    const bare = new Hono()
    mountControlPlaneRouteContributions({
      contributions: createSelfHostedTasksComposition({ services: services(), grants }).routeContributions,
      mount: (contribution) => bare.route(contribution.path, contribution.routes),
    })
    const token = await grants.issue({ workspaceId: "ws_root", sessionId: "ses_1" })
    if (!token) throw new Error("the fixture issued no grant")
    await command(bare, "alice", "owner-preset", PRESET)
    const created = await command(bare, "alice", "owner-task", { ...TASK, input: { ...TASK.input, workspaceId: "ws_other" } })
    const taskId = (created.body.result as { task: { id: string } }).task.id
    const presets = (await (await bare.request(`${ORIGIN}${TASKS}/presets`, { headers: headers("alice") })).json()) as {
      items: Array<{ id: string }>
    }

    const preview = await bare.request(`${ORIGIN}${TASKS}/tasks/${taskId}/start-preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        taskRevision: 1,
        presetId: presets.items[0]?.id,
        presetRevision: 1,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    expect(preview.status).toBe(403)
    expect(await preview.json()).toMatchObject({ error: { message: "This session may act only in project project-a" } })
  })

  test("a session's handle stops answering the moment this machine turns Tasks off, and answers again when it is back on", async () => {
    const owners: Record<string, TasksCapabilityOwner> = {
      ws_root: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
    }
    let tasksOn = true
    const grants = createTasksSessionGrants({ workspaceOwner: async (workspaceId) => owners[workspaceId], enabled: () => tasksOn })
    const bare = new Hono()
    mountControlPlaneRouteContributions({
      contributions: createSelfHostedTasksComposition({ services: services(), grants }).routeContributions,
      mount: (contribution) => bare.route(contribution.path, contribution.routes),
    })
    const token = await grants.issue({ workspaceId: "ws_root", sessionId: "ses_1" })
    if (!token) throw new Error("the fixture issued no grant")
    const list = () => bare.request(`${ORIGIN}${TASKS}/tasks?projectId=project-a`, { headers: { authorization: `Bearer ${token}` } })
    expect((await list()).status).toBe(200)

    tasksOn = false
    const refused = await list()
    expect(refused.status).toBe(401)
    expect(await grants.issue({ workspaceId: "ws_root", sessionId: "ses_2" })).toBeUndefined()

    tasksOn = true
    expect((await list()).status).toBe(200)
  })

  test("a task written by one request is still there for the next composition", async () => {
    await command(app(), "alice", "request-durable", TASK)

    const listed = await app().request(`${ORIGIN}${TASKS}/tasks?projectId=project-a`, { headers: headers("alice") })
    expect(await listed.json()).toMatchObject({ items: [{ title: "Ship the signed self-host" }] })
  })
})
