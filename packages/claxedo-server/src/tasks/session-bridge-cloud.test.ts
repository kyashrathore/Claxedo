/**
 * Cloud placement through the real sandbox manager and a fake driver. The
 * allocation, its readiness and its failure cleanup are the real ones; what is
 * faked is the driver's provider, the authority whose rows record each root,
 * and the HTTP surface of the workspace runtime the session is created on.
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  SandboxProviderRateLimitedError,
  createSandboxManager,
  type SandboxDriver,
  type SandboxEnsureResult,
  type SandboxManager,
} from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import {
  startConfigurationDigest,
  startOriginId,
  type ConfigurationSlot,
  type Preset,
  type StartCommand,
  type Task,
} from "@claxedo/tasks"
import { originCloudWorkspaceId } from "../workspace/origin-cloud-workspace"
import { createCloudCreateAdmission } from "../workspace/cloud-create-admission"
import { createFixedWindowConnectionRateLimiter } from "../platform/auth/rate-limit"
import { createHostedTasksSessionBridge, type HostedTasksSessionBridgeInput } from "./session-bridge"
import { composeProviderNeutralHostedControlPlane } from "../authority/provider-neutral-hosted-services"
import type { ControlPlaneServices } from "../authority/services"
import { unusedSandboxStarts } from "../test-support/inline-sandbox-start"
import type { TasksHostReads } from "./d1-host-reads"
import { startedSession } from "@claxedo/tasks/test-support"
import { hostedSandboxInput } from "../workspace/hosted-sandbox-input"
import type { SandboxStart, SandboxStartRequest } from "../workspace/sandbox-start"

const mock = vi.hoisted(() => ({ request: vi.fn(), register: (_workspaceId: string, _sessionId: string) => {} }))
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

let filed = new Map<string, Workspace>()

type RootArgs = {
  workspaceId: string
  projectId?: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
}

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
      const headers = new Headers(init?.headers)
      if (headers.get("x-claxedo-session-registration-operation")) mock.register(workspaceId, String(body.id))
      rows.set(String(body.id), {
        instructions: typeof body.instructions === "string" ? body.instructions : "",
        ...(typeof body.variant === "string" ? { variant: body.variant } : {}),
      })
      return Response.json({ id: String(body.id), directory: "/workspace", time: { created: 1, updated: 1 } }, { status: 201 })
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
    if (read) return rows.has(read[1]) ? Response.json({ id: read[1], time: { created: 1, updated: 1 } }) : Response.json({}, { status: 404 })
    return Response.json({ error: { code: "unexpected", message: requestPath } }, { status: 500 })
  })
  return { sessions }
}

function services(
  sandboxManager: SandboxManager | undefined,
  sandbox: ControlPlaneServices["sandbox"] = {
    orgDriver: async () => fakeDriver({ id: "modal" }).driver,
  },
) {
  const created = new Map<string, Workspace>()
  filed = created
  const file =(args: RootArgs, orgId: string) => {
    if (created.has(args.workspaceId)) return { workspace_id: args.workspaceId }
    created.set(args.workspaceId, {
      id: args.workspaceId,
      org_id: orgId,
      project_id: args.projectId ?? PROJECT,
      workspace_name: args.displayName,
      directory: args.remoteDirectory ?? "/workspace",
      kind: "cloud",
      ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
      ...(args.repoName ? { repo_name: args.repoName } : {}),
      ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
      ...(args.remoteDirectory ? { remote_directory: args.remoteDirectory } : {}),
      created_at: 1,
      updated_at: 1,
    })
    return { workspace_id: args.workspaceId }
  }
  const registered = new Map<string, { workspaceID: string }>()
  mock.register = (workspaceId, sessionId) => registered.set(sessionId, { workspaceID: workspaceId })
  const reads: TasksHostReads = {
    workspace: async (workspaceId) => created.get(workspaceId),
    projectWorkspaces: async () => [],
    projectSource: async (projectId) => (projectId === PROJECT ? { repoUrl: REPO, gitBranch: "main", repoName: "importer" } : undefined),
    sessions: async (ids) => new Map([...registered].filter(([id]) => ids.includes(id))),
  }
  const authority = {
    reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: { operationId: string; sessionId: string }) => ({
      ...intent,
      changed: true,
      state: "reserved" as const,
    })),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeWorkspaceCreate: vi.fn(async () => ({ orgId: "org" })),
    auditDeny: vi.fn(async () => undefined),
    createCloudWorkspace: vi.fn(async (_auth: unknown, args: RootArgs) => file(args, "org")),
    createRuntimeCloudWorkspace: vi.fn(async (_principal: unknown, args: RootArgs & { orgId: string }) => file(args, args.orgId)),
  }
  return {
    authority,
    created,
    reads,
    value: {
      authority,
      sandbox: { ...(sandboxManager ? { sandboxManager } : {}), ...sandbox },
      relay: { relayUrls: { "us-east": "https://relay.claxedo.test" } },
      defaultHomeRegion: "us-east",
    } as unknown as ControlPlaneServices,
  }
}

type StartRequestRecord = { workspaceId: string; request: SandboxStartRequest | undefined }

/** The sandbox input the deployment's provisioner builds a root's sandbox from: its filed row. */
function rootInput(workspaceId: string, onLeaseOpened?: () => void) {
  const row = filed.get(workspaceId)
  if (!row) throw new Error(`no root ${workspaceId} was filed before its start`)
  return hostedSandboxInput(
    { workspace_id: row.id, project_id: row.project_id, repo_url: row.repo_url, git_branch: row.git_branch, remote_directory: row.remote_directory },
    { egress: { defaultHomeRegion: "us-east" }, preparation: undefined, ...(onLeaseOpened ? { onLeaseOpened } : {}) },
  )
}

/**
 * The workspace's sandbox start the way its provisioner answers it, over the
 * real manager: a start of a serving sandbox answers ready, any other start
 * takes the lease and answers at once, and `settle` runs the driver steps the
 * provisioner's alarm runs until the start settles.
 */
function provisioner(sandboxManager: SandboxManager) {
  const requests: StartRequestRecord[] = []
  const start: SandboxStart = async (workspaceId, request) => {
    requests.push({ workspaceId, request })
    const current = await sandboxManager.target(workspaceId)
    if (current.status === "ready") return current
    let opened = false
    const acquired = await sandboxManager.acquire(workspaceId, rootInput(workspaceId, () => {
      opened = true
    }))
    return acquired.status === "provisioning" && opened ? { ...acquired, opened: true } : acquired
  }
  const settle = async (workspaceId: string): Promise<SandboxEnsureResult> => {
    const lease = await sandboxManager.target(workspaceId)
    if (lease.status === "ready") return lease
    const epoch = (await sandboxManager.list()).find((row) => row.workspaceId === workspaceId)?.epoch
    if (epoch === undefined) throw new Error(`no lease for ${workspaceId} to settle`)
    for (;;) {
      const answer = await sandboxManager.provision(workspaceId, epoch, rootInput(workspaceId))
      if (answer.status !== "provisioning") return answer
    }
  }
  return { start, settle, requests }
}

/** A start that answers what its run settled with, for a case about the answer rather than the wait. */
function settledStart(answer: Awaited<ReturnType<SandboxStart>>): SandboxStart {
  return async () => answer
}

const OWNER = { userId: "usr_owner", actorId: "act_owner", orgId: "org", projectId: PROJECT }
const OWNER_PRINCIPAL = { principalKind: "user", actorId: OWNER.actorId, actorKind: "human" }

/**
 * Who the Tasks actor was minted from: the signed person (the app's own
 * Start), the workspace owner a grant resolved to (a session's agent), or
 * nobody this host can name.
 */
type Identity = Pick<HostedTasksSessionBridgeInput, "auth" | "owner">

const signedPerson: Identity = {
  auth: () => ({ user: { subject: "owner" }, principal: { userId: OWNER.userId } }) as unknown as SignedControlPlaneAuth,
}
const grantOwner: Identity = { owner: () => OWNER }

type BridgeOptions = {
  sandboxStart?: SandboxStart | null
  identity?: Identity
  admission?: HostedTasksSessionBridgeInput["cloudCreateAdmission"]
  sandboxUsage?: HostedTasksSessionBridgeInput["sandboxUsage"]
}

function bridge(composition: ReturnType<typeof services>, options: BridgeOptions = {}) {
  const sandboxManager = (composition.value.sandbox as { sandboxManager?: SandboxManager }).sandboxManager
  const sandboxStart = options.sandboxStart === undefined
    ? sandboxManager && provisioner(sandboxManager).start
    : options.sandboxStart
  return createHostedTasksSessionBridge({
    services: composition.value,
    runtimeClient: {},
    reads: composition.reads,
    principal: async () => ({ principalKind: "user", actorId: OWNER.actorId, actorKind: "human" }),
    ...(options.identity ?? signedPerson),
    ...(sandboxStart ? { sandboxStart } : {}),
    ...(options.admission ? { cloudCreateAdmission: options.admission } : {}),
    ...(options.sandboxUsage ? { sandboxUsage: options.sandboxUsage } : {}),
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
    childNumber: null,
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

async function preview(kit: ReturnType<typeof bridge>, taskId: string) {
  const previewed = await kit.preview(previewCommand(taskId))
  if (!previewed.ok) throw new Error(`preview refused: ${previewed.error.message}`)
  return previewed.preview
}

/**
 * Preview, then start; a root whose start is still under way is settled and
 * the same Start sent again, which is what the app does once the root runs.
 */
async function start(kit: ReturnType<typeof bridge>, taskId: string, boot?: ReturnType<typeof provisioner>) {
  const previewed = await preview(kit, taskId)
  const command = await startCommand(taskId, previewed.digest)
  const first = await kit.start(command)
  if (!first.ok || !("preparing" in first)) return { preview: previewed, first, started: first }
  if (!boot) throw new Error(`the root ${first.preparing.workspaceId} is still starting and this case settles no boot`)
  expect(await boot.settle(first.preparing.workspaceId)).toMatchObject({ status: "ready" })
  return { preview: previewed, first, started: await kit.start(command) }
}

/** A composition whose roots boot through `provisioner`, and the bridge that starts them. */
function booting(composition: ReturnType<typeof services>, options: Omit<BridgeOptions, "sandboxStart"> = {}) {
  const sandboxManager = (composition.value.sandbox as { sandboxManager?: SandboxManager }).sandboxManager
  if (!sandboxManager) throw new Error("this composition has no sandbox manager to boot a root on")
  const boot = provisioner(sandboxManager)
  return { boot, kit: bridge(composition, { ...options, sandboxStart: boot.start }) }
}

/** The authority row the latest composition filed for a task's root, if any. */
async function rootOf(taskId: string): Promise<Workspace | undefined> {
  return filed.get(await originCloudWorkspaceId(startOriginId("org", taskId, slot, 1)))
}

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * The keys the hosted composition demands before it will build any services.
 * Ed25519, so they are short enough to inline and real enough for the signer
 * the composition constructs at boot.
 */
const HOSTED_TOKEN_KEYS = {
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
    "-----END PUBLIC KEY-----",
  ].join("\n"),
}

/**
 * The hosted control plane a Worker entry composes, with this file's fake
 * driver built where the entry builds one from an organization's key, and the
 * organization holding one such key (or none).
 *
 * Built here rather than hand-writing a `sandbox` object because the driver
 * the allocator places a root on is one the composition DERIVES from the
 * organization's keys: a services object assembled by a test cannot tell
 * whether the composition still derives it.
 */
function composedHostedServices(driver: SandboxDriver, orgKeys: readonly string[] = [driver.id]) {
  const rows = orgKeys.map((providerId, index) => ({
    id: `cred_${providerId}`, owner: null, provider_id: providerId, kind: "sandbox_driver", status: "active", revision: 1, created_at: index,
  }))
  return composeProviderNeutralHostedControlPlane(
    {
      ...HOSTED_TOKEN_KEYS,
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.claxedo.test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
    },
    {
      auth: { config: { enabled: true, mode: "signed" } } as never,
      authority: { resolveWorkspaceOwner: async () => ({ orgId: "org" }) } as never,
      hostTunnelResolver: (async () => undefined) as never,
      orgCredentials: () => ({
        listCredentials: async () => rows,
        resolveCredentialSecretById: async () => JSON.stringify({ api_key: "bx" }),
      }) as never,
      sandbox: {
        leaseStore: createMemoryLeaseStore(),
        keys: { drivers: ["cloudflare", "boat"], create: () => driver, chosenDriver: async () => undefined },
        ...unusedSandboxStarts,
      },
    },
  ).services
}

describe("hosted tasks cloud roots", () => {
  test("a preview files no root, opens no lease and starts no sandbox, and answers at once", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const kit = bridge(composition)

    const previewed = await kit.preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true, preview: { available: true, blockers: [], placement: "cloud" } })
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect([...composition.created.keys()]).toEqual([])
    expect(await sandboxManager.list()).toEqual([])
    expect(ensured).toEqual([])
    expect(mock.request).not.toHaveBeenCalled()
  })

  test("a Start answers once the root's lease is taken, naming its workspace, and the same Start sent once it runs creates the session there", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const { kit, boot } = booting(composition)

    const previewed = await preview(kit, "tsk_one")
    const command = await startCommand("tsk_one", previewed.digest)
    const root = await originCloudWorkspaceId(startOriginId("org", "tsk_one", slot, 1))
    expect(await kit.start(command)).toEqual({ ok: true, preparing: { workspaceId: root } })
    expect(await rootOf("tsk_one")).toMatchObject({ id: root, kind: "cloud", repo_url: REPO })
    expect(await sandboxManager.target(root)).toMatchObject({ status: "unavailable" })
    expect(ensured).toEqual([])
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(mock.request).not.toHaveBeenCalled()

    // A resent Start while the root still boots joins the same start.
    expect(await kit.start(command)).toEqual({ ok: true, preparing: { workspaceId: root } })
    expect(await sandboxManager.list()).toMatchObject([{ workspaceId: root, epoch: 1 }])

    expect(await boot.settle(root)).toMatchObject({ status: "ready" })
    const started = await kit.start(command)
    expect(started).toMatchObject({ ok: true, session: { sessionRef: { workspaceId: root } } })
    expect(ensured).toEqual([root])
    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledOnce()
  })

  test("starts the root through the workspace's own sandbox start, as a person's start, with the preset's capability set", async () => {
    runtime()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver })
    const composition = services(sandboxManager)
    const { kit, boot } = booting(composition)

    await start(kit, "tsk_one", boot)
    const root = (await rootOf("tsk_one"))?.id
    expect(boot.requests).toEqual([
      { workspaceId: root, request: { retry: true, capabilities: cloudPreset().execution.capabilities } },
      { workspaceId: root, request: { retry: true, capabilities: cloudPreset().execution.capabilities } },
    ])
  })

  test("gives two roots in one project two workspaces with distinct ids and sandboxes", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const { kit, boot } = booting(composition)

    const one = startedSession((await start(kit, "tsk_one", boot)).started).sessionRef.workspaceId
    const two = startedSession((await start(kit, "tsk_two", boot)).started).sessionRef.workspaceId
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

  test("a retried start recovers the same root instead of allocating a second", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const { kit, boot } = booting(composition)

    const first = startedSession((await start(kit, "tsk_one", boot)).started)
    composition.authority.createCloudWorkspace.mockClear()
    const again = startedSession((await start(kit, "tsk_one", boot)).started)

    const root = first.sessionRef.workspaceId
    expect(again.sessionRef).toEqual(first.sessionRef)
    expect(new Set(ensured)).toEqual(new Set([root]))
    // The retry re-admits the row it found rather than trusting it: the
    // authority holds a second filing of the id to the first, owner included,
    // which is what refuses anyone else's retry of this root.
    const admitted = composition.authority.createCloudWorkspace.mock.calls.map(
      ([, args]: [unknown, { workspaceId: string }]) => args.workspaceId,
    )
    expect(admitted.length).toBeGreaterThan(0)
    expect(new Set(admitted)).toEqual(new Set([root]))
    expect([...composition.created.keys()]).toEqual([root])
    // One sandbox, not a replacement: a second allocation would have burned a
    // lease epoch and left the first root's files behind.
    expect(await sandboxManager.list()).toMatchObject([{ workspaceId: root, epoch: 1 }])
  })

  test("a root whose start the provider refused at its daily limit is refused in one line with the reason a person is told, not the lease's coded error", async () => {
    runtime()
    const { driver } = fakeDriver()
    const limited: SandboxDriver = {
      ...driver,
      ensureHost: async () => {
        throw new SandboxProviderRateLimitedError({ window: "day", limit: 200 }, "the start limit is used up")
      },
    }
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: limited })
    const composition = services(sandboxManager)
    const refused: SandboxStart = async (workspaceId) => {
      for (;;) {
        const answer = await sandboxManager.ensure(workspaceId, rootInput(workspaceId))
        if (answer.status !== "provisioning") return answer
      }
    }

    const { started } = await start(bridge(composition, { sandboxStart: refused }), "tsk_limited")
    expect(started).toEqual({
      ok: false,
      error: {
        code: "unsupported",
        message: `The cloud workspace could not start: ${driver.id}'s daily start limit (200) is used up; try again later.`,
      },
    })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
  })

  test("a root whose runtime preparation failed is refused in one line, and no session is reserved", async () => {
    runtime()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver }))
    const sandboxStart = settledStart({ status: "failed", code: "runtime_prepare_failed", message: "Agent Plugins runtime did not acknowledge the selected capability set" })

    const { started } = await start(bridge(composition, { sandboxStart }), "tsk_one")
    expect(started).toEqual({
      ok: false,
      error: { code: "unsupported", message: "The task's plugins and skills could not be set up for this start." },
    })
    expect(composition.authority.reserveRuntimeSession).not.toHaveBeenCalled()
  })

  test("refuses cloud placement on a deployment that provisions no sandboxes, and allocates nothing", async () => {
    runtime()
    const composition = services(undefined)

    const previewed = await bridge(composition).preview(previewCommand("tsk_one"))
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.available).toBe(false)
    expect(previewed.preview.blockers).toEqual([
      { code: "placement_unsupported", detail: "This control plane provisions no cloud sandboxes" },
    ])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("a manager whose driver the placement cannot name refuses the start, and says so distinctly", async () => {
    runtime()
    const composition = services(
      createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver }),
      { orgDriver: async () => fakeDriver().driver },
    )

    const { preview: previewed, started } = await start(bridge(composition), "tsk_one")
    const refusal = "This control plane's sandbox provisioner is not one a workspace placement can name"
    expect(previewed.blockers).toEqual([{ code: "placement_unsupported", detail: refusal }])
    expect(started).toMatchObject({ ok: false, error: { message: refusal } })
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("a root allocated over the real hosted composition is placed on the driver its organization's key builds", async () => {
    runtime()
    const { driver } = fakeDriver({ id: "cloudflare" })
    const sandbox = composedHostedServices(driver)
    expect((await sandbox.sandbox.orgDriver!("org")).id).toBe("cloudflare")
    const composition = services(undefined, sandbox.sandbox)
    const sandboxUsage = { leaseOpened: vi.fn(), recordLeaseTenant: vi.fn(async () => undefined) }
    const { kit, boot } = booting(composition, { sandboxUsage })

    expect((await start(kit, "tsk_one", boot)).started).toMatchObject({ ok: true })
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: (await rootOf("tsk_one"))?.id, driver: "cloudflare" }))
  })

  test("an organization without a sandbox provider key is refused a root, and told which key to add", async () => {
    runtime()
    const sandbox = composedHostedServices(fakeDriver({ id: "cloudflare" }).driver, [])
    const composition = services(undefined, sandbox.sandbox)

    const { started } = await start(bridge(composition), "tsk_one")
    expect(started).toMatchObject({ ok: false, error: { message: expect.stringContaining("Add a sandbox provider key") } })
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("places a root on its organization's own sandbox key and opens its lease metered against that driver, once", async () => {
    runtime()
    const orgDriver = vi.fn(async () => fakeDriver({ id: "boat" }).driver)
    const composition = services(
      createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver }),
      { orgDriver, workspaceDriver: async () => fakeDriver({ id: "boat" }).driver },
    )
    const sandboxUsage = { leaseOpened: vi.fn(), recordLeaseTenant: vi.fn(async () => undefined) }
    const { kit, boot } = booting(composition, { sandboxUsage })

    expect((await start(kit, "tsk_one", boot)).started).toMatchObject({ ok: true })
    const root = await rootOf("tsk_one")
    expect(root).toMatchObject({ kind: "cloud", project_id: PROJECT })
    expect(orgDriver).toHaveBeenCalledWith("org")
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledOnce()
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: root?.id, driver: "boat" }))
    expect(sandboxUsage.recordLeaseTenant).toHaveBeenCalledOnce()
  })

  test("allocates a root for a grant's resolved owner through the runtime-principal path, as that owner", async () => {
    runtime()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver().driver }))
    const { kit, boot } = booting(composition, { identity: grantOwner })

    const { preview: previewed, started } = await start(kit, "tsk_one", boot)
    expect(previewed.blockers).toEqual([])
    const root = await rootOf("tsk_one")
    expect(startedSession(started).sessionRef.workspaceId).toBe(root?.id)
    // No signed principal exists for a grant, and none is fabricated: the
    // authority is asked as the owner's canonical actor, under the owner's
    // organization and the task's project.
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect(composition.authority.createRuntimeCloudWorkspace).toHaveBeenCalledWith(OWNER_PRINCIPAL, {
      workspaceId: root?.id,
      orgId: OWNER.orgId,
      projectId: PROJECT,
      displayName: "Fix tsk_one (primary, attempt 1)",
      repoUrl: REPO,
      repoName: "importer",
      gitBranch: "main",
      remoteDirectory: "/workspace",
      homeRegion: "us-east",
    })
    expect(composition.authority.reserveRuntimeSession).toHaveBeenCalledWith(OWNER_PRINCIPAL, expect.objectContaining({
      workspaceId: root?.id,
    }))
  })

  test("refuses an actor that is neither signed nor a grant's resolved owner before any sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))

    const { started } = await start(bridge(composition, { identity: {} }), "tsk_one")
    expect(started).toMatchObject({
      ok: false,
      error: { code: "unsupported", message: expect.stringContaining("This caller may not create a cloud workspace here") },
    })
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect(composition.authority.createRuntimeCloudWorkspace).not.toHaveBeenCalled()
  })

  test("refuses a grant's owner on an authority that cannot create a workspace for a runtime principal", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const { createRuntimeCloudWorkspace: _absent, ...authority } = composition.authority
    const value = { ...(composition.value as unknown as Record<string, unknown>), authority } as unknown as ControlPlaneServices

    const { started } = await start(bridge({ ...composition, value }, { identity: grantOwner }), "tsk_one")
    expect(started).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("cannot create a cloud root for a session's grant") },
    })
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
  })

  test("refuses a cloud preset whose harness runs in its own session host, before a row or a sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const pi: Preset = { ...cloudPreset(), configurations: { primary: { harness: { id: "pi", access: "native" }, model: MODEL, effort: null } } }

    const previewed = await bridge(composition).preview({ ...previewCommand("tsk_one"), preset: pi })
    expect(previewed).toMatchObject({ ok: true })
    if (!previewed.ok) return
    expect(previewed.preview.blockers).toEqual([
      { code: "harness_unavailable", detail: expect.stringContaining("Pi runs in its own session host on a cloud workspace") },
    ])
    expect(ensured).toEqual([])
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("refuses a cloud root on a deployment with no sandbox start, before any row or sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))

    const { preview: previewed, started } = await start(bridge(composition, { sandboxStart: null }), "tsk_one")
    expect(previewed.blockers).toEqual([
      { code: "placement_unsupported", detail: "This control plane cannot start a cloud root" },
    ])
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(ensured).toEqual([])
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })
})

/**
 * The admission `POST /api/workspace/create` applies, reached through the
 * tasks bridge rather than the route: a task's cloud root is the same create
 * on another door, so the same gates — the authority's own admission, the
 * paid-capability entitlement, the concurrent-lease cap, and the per-caller
 * create budget — answer the Start before a row or a sandbox exists.
 */
describe("hosted tasks cloud create admission", () => {
  test("the authority's create admission refuses a signed caller before a row or a sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    composition.authority.authorizeWorkspaceCreate.mockRejectedValue(
      new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace creation authority was denied"),
    )

    const { started } = await start(bridge(composition), "tsk_one")
    expect(started).toEqual({ ok: false, error: { code: "unsupported", message: "Workspace creation authority was denied" } })
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("the entitlement gate refuses a signed caller's start before a row or a sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const entitlement = vi.fn(async () => ({
      status: 402 as const,
      body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
    }))
    const admission = createCloudCreateAdmission({ services: composition.value, entitlement })

    const { started } = await start(bridge(composition, { admission }), "tsk_one")
    expect(started).toEqual({ ok: false, error: { code: "unsupported", message: "subscription required" } })
    // The tenant the gate answered for is the signed request itself.
    expect(entitlement).toHaveBeenCalledWith({ auth: expect.objectContaining({ user: { subject: "owner" } }) })
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("the entitlement gate refuses a grant-owner start on the owner's organization", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const entitlement = vi.fn(async () => ({
      status: 402 as const,
      body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
    }))
    const admission = createCloudCreateAdmission({ services: composition.value, entitlement })

    const { started } = await start(bridge(composition, { identity: grantOwner, admission }), "tsk_one")
    expect(started).toEqual({ ok: false, error: { code: "unsupported", message: "subscription required" } })
    // No bearer exists for a grant's owner to sign with, so the gate is asked
    // by the organization the root lands in — the same tenant the create
    // charges.
    expect(entitlement).toHaveBeenCalledWith({ orgId: OWNER.orgId })
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createRuntimeCloudWorkspace).not.toHaveBeenCalled()
  })

  test("the concurrent-lease cap refuses the start at the ceiling, before a row or a sandbox exists", async () => {
    runtime()
    const { driver, ensured } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    const countActiveLeases = vi.fn(async () => 25)
    const admission = createCloudCreateAdmission({ services: composition.value, countActiveLeases })

    const { started } = await start(bridge(composition, { admission }), "tsk_one")
    expect(started).toMatchObject({ ok: false, error: { code: "unsupported", message: expect.stringContaining("stop one to start another") } })
    // The signed caller is counted by their token subject — the same column a
    // lease's tenant stamp carries.
    expect(countActiveLeases).toHaveBeenCalledWith({ ownerSubject: "owner" })
    expect(composition.authority.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ user: { subject: "owner" } }),
      expect.objectContaining({ action: "workspace.create.denied", reason: "sandbox_lease_limit_reached" }),
    )
    expect(ensured).toEqual([])
    expect(await rootOf("tsk_one")).toBeUndefined()
    expect(composition.authority.createCloudWorkspace).not.toHaveBeenCalled()
  })

  test("the concurrent-lease cap does not refuse the retry of a root it already counts", async () => {
    runtime()
    const { driver } = fakeDriver()
    const composition = services(createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }))
    // The first admission admits and allocates; a second admission rebuilt at
    // the ceiling must still re-admit the row the first filed — its lease is
    // the cap's own, not new spend.
    const { kit, boot } = booting(composition, {
      admission: createCloudCreateAdmission({ services: composition.value, countActiveLeases: async () => 0 }),
    })
    expect((await start(kit, "tsk_one", boot)).started).toMatchObject({ ok: true })

    const capped = bridge(composition, {
      sandboxStart: boot.start,
      admission: createCloudCreateAdmission({ services: composition.value, countActiveLeases: async () => 25 }),
    })
    expect((await start(capped, "tsk_one", boot)).started).toMatchObject({ ok: true })
  })

  test("the create budget bounds task-driven creates", async () => {
    runtime()
    const { driver } = fakeDriver()
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    const composition = services(sandboxManager)
    const admission = createCloudCreateAdmission({
      services: composition.value,
      rateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
    })
    const { kit } = booting(composition, { admission })

    // The first Start is the budget's one spend; the second stops before a
    // root is filed for it.
    const first = await kit.start(await startCommand("tsk_one", (await preview(kit, "tsk_one")).digest))
    expect(first).toMatchObject({ ok: true, preparing: {} })
    const again = await kit.start(await startCommand("tsk_two", (await preview(kit, "tsk_two")).digest))
    expect(again).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(await sandboxManager.list()).toHaveLength(1)
  })
})
