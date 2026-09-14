/**
 * Cloud placement through the real workspace store, the real sandbox manager
 * and a fake driver. The allocation, its readiness and its failure cleanup are
 * the real ones; what is faked is the driver's provider and the HTTP surface
 * of the workspace runtime the session is created on.
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  createSandboxManager,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxManager,
} from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  deleteWorkspace,
  ensureWorkspace,
  getProjectWorkspace,
  getWorkspace,
  listWorkspaces,
  type Workspace,
} from "@claxedo/server-core/workspace/store/index"
import {
  startConfigurationDigest,
  startOriginId,
  type ConfigurationSlot,
  type Preset,
  type StartCommand,
  type Task,
} from "@claxedo/tasks"
import { originCloudWorkspaceId } from "../workspace/origin-cloud-workspace"
import { createHostedTasksSessionBridge } from "./session-bridge"
import type { TasksRootIdentity } from "./root-capability"
import type { ControlPlaneServices } from "../authority/services"

// Hoisted above the imports so it is set before the store's first read: left
// unset, every row this file writes would land in the developer's own data
// directory.
const data = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")
  const root = `${tmp}/claxedo-tasks-cloud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  process.env.CLAXEDO_DATA_DIR = root
  return root
})

const mock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@claxedo/server-core/workspace/http/workspace-runtime-client", () => ({
  createWorkspaceRuntimeClient: ({ workspace }: { workspace: { id: string } }) => ({
    request: (requestPath: string, init?: RequestInit) => mock.request(workspace.id, requestPath, init),
  }),
}))

const HARNESS = { id: "codex", access: "native" as const }
const MODEL = { providerID: "openai", modelID: "gpt-5" }
const PROJECT = "prj_cloud"
const REPO = "https://github.com/acme/importer.git"
const slot: ConfigurationSlot = "primary"
const actor = { scopeId: "org", ownerId: "owner" }

/**
 * A driver plus the workspaces it was asked to host. `ensureHost` runs on
 * every `ensure` — a ready lease is re-ensured so an auto-stopped sandbox
 * resumes — so the set of workspaces it saw, not the number of calls, is what
 * says how many sandboxes were allocated.
 */
function fakeDriver(overrides: Partial<SandboxDriver> = {}) {
  const ensured: string[] = []
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
      ensured.push(input.workspaceId)
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://runtime.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    },
    ...overrides,
  }
  return { driver, ensured }
}

/** The endpoints a Start touches, answered per workspace so two roots cannot read each other's sessions. */
function runtime() {
  const sessions = new Map<string, Map<string, { instructions: string; variant?: string }>>()
  mock.request.mockImplementation(async (workspaceId: string, requestPath: string, init?: RequestInit) => {
    const rows = sessions.get(workspaceId) ?? new Map<string, { instructions: string; variant?: string }>()
    sessions.set(workspaceId, rows)
    if (requestPath.startsWith("/session/capabilities")) {
      return Response.json({
        harness: HARNESS.id,
        modelSelection: {
          status: "optional",
          models: [{ providerId: MODEL.providerID, modelId: MODEL.modelID, name: "GPT-5" }],
        },
      })
    }
    if (requestPath.startsWith("/session?")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      rows.set(String(body.id), {
        instructions: typeof body.instructions === "string" ? body.instructions : "",
        ...(typeof body.variant === "string" ? { variant: body.variant } : {}),
      })
      return Response.json({ id: String(body.id), directory: "/workspace" }, { status: 201 })
    }
    const message = /^\/session\/([^/]+)\/message$/.exec(requestPath)
    if (message) return rows.has(message[1]) ? Response.json([]) : Response.json({}, { status: 404 })
    const config = /^\/session\/([^/]+)\/config$/.exec(requestPath)
    if (config) {
      const row = rows.get(config[1])
      if (!row) return Response.json({}, { status: 404 })
      return Response.json({ harness: HARNESS, model: MODEL, variant: row.variant ?? null, instructions: row.instructions })
    }
    const read = /^\/session\/([^/]+)$/.exec(requestPath)
    if (read) return rows.has(read[1]) ? Response.json({ id: read[1] }) : Response.json({}, { status: 404 })
    return Response.json({ error: { code: "unexpected", message: requestPath } }, { status: 500 })
  })
  return { sessions }
}

function services(sandboxManager: SandboxManager | undefined) {
  const created = new Map<string, { projectId?: string; displayName: string }>()
  const authority = {
    reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: { operationId: string; sessionId: string }) => ({
      ...intent,
      changed: true,
      state: "reserved" as const,
    })),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    createCloudWorkspace: vi.fn(
      async (_auth: unknown, args: { workspaceId: string; projectId?: string; displayName: string }) => {
        created.set(args.workspaceId, {
          ...(args.projectId ? { projectId: args.projectId } : {}),
          displayName: args.displayName,
        })
        return { workspace_id: args.workspaceId }
      },
    ),
    deleteWorkspace: vi.fn(async (_auth: unknown, args: { workspaceId: string }) => {
      created.delete(args.workspaceId)
      return {}
    }),
  }
  const projectionStore = {
    session_metas: vi.fn(async () => new Map()),
    put_session_meta: vi.fn(async () => undefined),
    delete_session_meta: vi.fn(async () => undefined),
  }
  return {
    authority,
    created,
    value: {
      authority,
      projectionStore,
      sandbox: { ...(sandboxManager ? { sandboxManager } : {}), defaultDriver: "daytona" },
      relay: { relayUrls: { "us-east": "https://relay.claxedo.test" } },
      defaultHomeRegion: "us-east",
    } as unknown as ControlPlaneServices,
  }
}

/**
 * A deployment that can project a capability set. What it projects is the
 * Agent Plugins module's subject; here it only has to exist, because a host
 * that cannot project one refuses cloud placement before it allocates
 * anything.
 */
function selectedCapabilities() {
  return {
    prepare: vi.fn(async () => ({})),
    apply: vi.fn(async () => undefined),
  }
}

function bridge(
  composition: ReturnType<typeof services>,
  port: ReturnType<typeof selectedCapabilities> | null = selectedCapabilities(),
  capability?: (root: TasksRootIdentity) => Promise<Record<string, string>>,
) {
  return createHostedTasksSessionBridge({
    services: composition.value,
    runtimeClient: {},
    principal: async () => ({ principalKind: "user", actorId: "act_owner", actorKind: "human" }),
    auth: () => ({
      user: { subject: "owner" },
      principal: { userId: "usr_owner" },
    }) as unknown as SignedControlPlaneAuth,
    ...(port ? { selectedCapabilities: port } : {}),
    ...(capability ? { capability } : {}),
    sandboxEgress: { controlPlaneOrigin: "https://cp.claxedo.test", extraHosts: ["registry.acme.test"] },
  })
}

function cloudPreset(): Preset {
  return {
    id: "pst_cloud",
    revision: 1,
    scopeId: "org",
    ownerId: "owner",
    name: "Isolated review",
    instructions: "Read before you write.",
    execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
    agentStartable: false,
    configurations: { primary: { harness: HARNESS, model: MODEL, effort: "high" } },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(id: string): Task {
  return {
    id,
    revision: 1,
    scopeId: "org",
    projectId: PROJECT,
    number: 1,
    workspaceId: null,
    parentTaskId: null,
    createdFrom: null,
    title: `Fix ${id}`,
    description: "",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function previewCommand(taskId: string) {
  return {
    actor,
    task: task(taskId),
    preset: cloudPreset(),
    slot,
    attempt: 1,
    continueFromPrevious: false,
    currentLink: null,
    currentState: null,
    authorizeTranscript: async () => true,
  }
}

async function startCommand(taskId: string, digest: string): Promise<StartCommand> {
  return {
    actor,
    task: task(taskId),
    preset: cloudPreset(),
    slot,
    attempt: 1,
    previewDigest: digest,
    continueFromPrevious: false,
    clientRequestId: `req_${taskId}`,
    configurationDigest: await startConfigurationDigest({ preset: cloudPreset(), slot }),
    previousSession: null,
    authorizeTranscript: async () => true,
  }
}

async function start(kit: ReturnType<typeof bridge>, taskId: string) {
  const previewed = await kit.preview(previewCommand(taskId))
  if (!previewed.ok) throw new Error(`preview refused: ${previewed.error.message}`)
  return { preview: previewed.preview, started: await kit.start(await startCommand(taskId, previewed.preview.digest)) }
}

async function rootOf(taskId: string): Promise<Workspace | undefined> {
  return await getWorkspace(await originCloudWorkspaceId(startOriginId("org", taskId, slot, 1)))
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const workspace of await listWorkspaces()) await deleteWorkspace(workspace.id)
  await ensureWorkspace({
    workspaceId: PROJECT,
    project_id: PROJECT,
    project_name: "importer",
    workspace_name: "importer",
    directory: "/workspace",
    kind: "cloud",
    repo_url: REPO,
    git_branch: "main",
    remote_directory: "/workspace",
  })
})

describe("hosted tasks cloud roots", () => {
  test("keeps every row it writes inside this file's own data directory", async () => {
    expect(await getWorkspace(PROJECT)).toBeDefined()
    expect(existsSync(path.join(data, "workspaces.json"))).toBe(true)
  })

  test("gives two roots in one project two workspaces with distinct ids and sandboxes", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const kit = bridge(composition)

    const first = await start(kit, "tsk_one")
    const second = await start(kit, "tsk_two")
    expect(first.started).toMatchObject({ ok: true })
    expect(second.started).toMatchObject({ ok: true })
    if (!first.started.ok || !second.started.ok) return

    const one = String(first.started.session.sessionRef.workspaceId)
    const two = String(second.started.session.sessionRef.workspaceId)
    expect(one).toBe((await rootOf("tsk_one"))?.id)
    expect(two).toBe((await rootOf("tsk_two"))?.id)
    expect(one).not.toBe(two)

    expect(await sandboxManager.target(one)).toMatchObject({ status: "ready", url: `https://runtime.test/${one}` })
    expect(await sandboxManager.target(two)).toMatchObject({ status: "ready", url: `https://runtime.test/${two}` })
    expect(new Set(ensured)).toEqual(new Set([one, two]))
    expect([...composition.created.keys()].sort()).toEqual([one, two].sort())

    // Each root clones the project's own authorized source at its ref.
    expect(await rootOf("tsk_one")).toMatchObject({ kind: "cloud", repo_url: REPO, git_branch: "main" })
  })

  test("boots a root under the same egress allowlist as every other hosted root", async () => {
    runtime()
    const seen: SandboxDriverEnsureInput[] = []
    const { driver } = fakeDriver()
    const sandboxManager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: {
        ...driver,
        ensureHost: async (input) => {
          seen.push(input)
          return driver.ensureHost(input)
        },
      },
    })
    const kit = bridge(services(sandboxManager))

    const started = await start(kit, "tsk_one")
    expect(started.started).toMatchObject({ ok: true })
    // A ready lease is re-ensured, so every ensure the driver saw is checked.
    expect(seen.length).toBeGreaterThan(0)
    for (const ensure of seen) {
      expect(ensure.source).toEqual({ kind: "git", repoUrl: REPO, branch: "main" })
      expect(ensure.net?.mode).toBe("restricted")
      const hosts = ensure.net?.hosts ?? []
      expect(hosts).toContain("relay.claxedo.test")
      expect(hosts).toContain("cp.claxedo.test")
      expect(hosts).toContain("github.com")
      expect(hosts).toContain("registry.acme.test")
    }
  })

  test("a retried start recovers the same root instead of allocating a second", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const kit = bridge(composition)

    const first = await start(kit, "tsk_one")
    composition.authority.createCloudWorkspace.mockClear()
    const again = await start(kit, "tsk_one")
    expect(first.started).toMatchObject({ ok: true })
    expect(again.started).toMatchObject({ ok: true })
    if (!first.started.ok || !again.started.ok) return

    const root = String(first.started.session.sessionRef.workspaceId)
    expect(again.started.session.sessionRef).toEqual(first.started.session.sessionRef)
    expect(new Set(ensured)).toEqual(new Set([root]))
    // The retry re-admits the row it found rather than trusting it. A store row
    // is not proof the authority still has one: a failed provision discards the
    // authority record and only tries to delete the store row, so a row that
    // survived that path would otherwise be a root the authority never heard of
    // and every later reservation in it would be refused.
    const admitted = composition.authority.createCloudWorkspace.mock.calls.map(
      ([, args]: [unknown, { workspaceId: string }]) => args.workspaceId,
    )
    expect(admitted.length).toBeGreaterThan(0)
    expect(new Set(admitted)).toEqual(new Set([root]))
    expect((await listWorkspaces()).filter((row) => row.id !== PROJECT)).toHaveLength(1)
    // One sandbox, not a replacement: a second allocation would have burned a
    // lease epoch and left the first root's files behind.
    expect(await sandboxManager.list()).toMatchObject([{ workspaceId: root, epoch: 1 }])
  })

  test("a sandbox that cannot be provisioned leaves no workspace and no authority record, and refuses the start", async () => {
    runtime()
    const { driver } = fakeDriver({
      ensureHost: async () => {
        throw new Error("the driver is out of quota")
      },
    })
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const kit = bridge(composition)

    const previewed = await kit.preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([
      { code: "source_unavailable", detail: expect.stringContaining("could not be provisioned") },
    ])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.created.size).toBe(0)
    expect(composition.authority.deleteWorkspace).toHaveBeenCalledTimes(1)

    const started = await kit.start(await startCommand("tsk_one", previewed.preview.digest))
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
  })

  test("refuses cloud placement on a deployment with no sandbox driver, and allocates nothing", async () => {
    runtime()
    const composition = services(undefined)

    const previewed = await bridge(composition).preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([
      { code: "placement_unsupported", detail: expect.stringContaining("No cloud sandbox driver is configured") },
    ])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("keeps a root out of its project's workspace list, so an ordinary start still resolves one workspace", async () => {
    runtime()
    const composition = services(
      createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver }),
    )
    expect((await start(bridge(composition), "tsk_one")).started).toMatchObject({ ok: true })

    const root = await rootOf("tsk_one")
    expect(root?.project_id).toBe(root?.id)
    expect((await getProjectWorkspace(PROJECT))?.id).toBe(PROJECT)
  })

  test("hands the root's own credentials to its sandbox and refuses a start the runtime did not acknowledge", async () => {
    runtime()
    const { driver } = fakeDriver()
    const brokered: unknown[] = []
    const recording: SandboxDriver = {
      ...driver,
      metadata: { ...driver.metadata, secretBrokering: "native" },
      ensureHost: async (input) => {
        brokered.push(input.secrets)
        return driver.ensureHost(input)
      },
    }
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: recording })
    const composition = services(sandboxManager)
    const port = {
      prepare: vi.fn(async () => ({ secrets: [{ name: "CLAXEDO_MCP_X", value: "Bearer x", hosts: ["mcp-x.example"], header: "Authorization" }] })),
      apply: vi.fn(async () => {
        throw new Error("Agent Plugins runtime did not acknowledge the selected capability set")
      }),
    }

    const previewed = await bridge(composition, port).preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([
      { code: "capability_unavailable", detail: expect.stringContaining("did not acknowledge the selected capability set") },
    ])

    // The credentials the selection resolved travel on the create itself,
    // which is the only channel a brokering driver reads them from.
    expect(port.prepare).toHaveBeenCalledWith({
      workspaceId: (await rootOf("tsk_one"))?.id,
      capabilities: { mode: "selected", plugins: [], skills: [] },
    })
    expect(brokered).toEqual([[{ name: "CLAXEDO_MCP_X", value: "Bearer x", hosts: ["mcp-x.example"], header: "Authorization" }]])
  })

  test("launches the root with the Tasks grant minted for it", async () => {
    runtime()
    const { driver } = fakeDriver()
    const environments: (Record<string, string> | undefined)[] = []
    const recording: SandboxDriver = {
      ...driver,
      ensureHost: async (input) => {
        environments.push(input.env)
        return driver.ensureHost(input)
      },
    }
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: recording }))
    const capability = vi.fn(async () => ({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" }))

    await bridge(composition, selectedCapabilities(), capability).preview(previewCommand("tsk_one"))

    // The grant names the workspace's owner as the authority records them, not
    // the token subject the Tasks actor carries; the signed identity travels
    // beside it, because what the project consented to is read as that caller.
    expect(capability).toHaveBeenCalledWith({
      userId: "usr_owner",
      orgId: "org",
      projectId: PROJECT,
      workspaceId: (await rootOf("tsk_one"))?.id,
    }, expect.objectContaining({ principal: { userId: "usr_owner" } }))
    expect(environments[0]).toMatchObject({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "grant-token" })
  })

  test("refuses a cloud root on a deployment that cannot project a capability set, before any sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))

    const previewed = await bridge(composition, null).preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.blockers).toEqual([
      { code: "capability_unavailable", detail: expect.stringContaining("cannot project a selected capability set") },
    ])
    expect(ensured).toEqual([])
  })
})
