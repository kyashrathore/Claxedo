import { afterEach, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { accountPlaceholderEnv } from "@claxedo/server-core/credentials/native-delivery-plan"
import { startOriginId, type Preset, type Task } from "@claxedo/tasks"
import type { RuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { createHostedRuntimeDelivery } from "../workspace/hosted-runtime-delivery"
import { originCloudWorkspaceId } from "../workspace/origin-cloud-workspace"
import { hostedBrokerCredentialReader, hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "../credentials/worker"
import { createHostedEgressBroker } from "../credentials/hosted-egress-broker"
import { unusedSandboxRedeliver, unusedSandboxStart, unusedWorkspaceIdleStop } from "../test-support/inline-sandbox-start"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import type { ControlPlaneServices } from "../authority/services"
import { createHostedTasksSessionBridge } from "./session-bridge"

const runtimeRequest = vi.hoisted(() => vi.fn())
const configApplied = vi.hoisted(() => vi.fn(async (_snapshot: RuntimeSnapshot) => {}))
vi.mock("@claxedo/server-core/workspace/http/workspace-runtime-client", () => ({
  createWorkspaceRuntimeClient: ({ workspace }: { workspace: { id: string } }) => ({
    request: (path: string, init?: RequestInit) => runtimeRequest(workspace.id, path, init),
  }),
}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({
  applyConfig: configApplied,
  configStatus: async () => ({ state: "applied", revision: 1 }),
})) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claxedo/server-core/platform/auth/runtime-access-token")>()),
  mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })),
}))

const PROJECT = "project"
const REPO = "https://github.com/acme/importer.git"
const ORIGIN = "https://api.claxedo.test"
const CREDENTIAL_ENV = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64") }
const TASK_ID = "tsk_accounts"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const task: Task = {
  id: TASK_ID, revision: 1, scopeId: "org", projectId: PROJECT, number: 1, childNumber: null, workspaceId: null, parentTaskId: null,
  createdFrom: null, title: "Fix accounts", description: "", status: "todo", childSetRevision: 0, archivedAt: null, createdAt: 1, updatedAt: 1,
}

const preset: Preset = {
  id: "pst_cloud", revision: 1, scopeId: "org", ownerId: "owner", name: "Cloud", instructions: "",
  execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
  agentStartable: false,
  configurations: { primary: { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "default" }, effort: null } },
  archivedAt: null, createdAt: 1, updatedAt: 1,
}

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

function recordingDriver(secretBrokering: "native" | "none", seen: SandboxDriverEnsureInput[]): SandboxDriver {
  return {
    id: "test-driver",
    metadata: {
      driverRunsIn: ["node"], hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host", targetAccess: "relay",
      secretBrokering, egressControl: "hosts-and-cidrs",
      persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
    },
    ensureHost: async (input) => {
      seen.push(input)
      return { sandboxId: `sandbox_${input.workspaceId}`, url: `https://runtime.test/${input.workspaceId}`, hostId: `host_${input.workspaceId}`, labels: input.labels }
    },
  }
}

async function rootStart(secretBrokering: "native" | "none") {
  const rootId = await originCloudWorkspaceId(startOriginId("org", TASK_ID, "primary", 1))
  const instance = await workspaceBackingDatabase([{ id: rootId, backing: "cloud-vm" }])
  active.push(instance)
  const database = instance.database as unknown as D1Database
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database, env: CREDENTIAL_ENV })
  const key = await credentials("org").putCredential({ owner: "owner", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-root-owner" })
  const seen: SandboxDriverEnsureInput[] = []
  const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: recordingDriver(secretBrokering, seen) })
  const signing = await signingEnv()
  const owner = { userId: "owner", actorId: "act_owner", orgId: "org", projectId: PROJECT }
  const filed = new Map<string, Workspace>()
  const authority = {
    resolveWorkspaceOwner: async () => owner,
    reserveRuntimeSession: vi.fn(async (_principal: unknown, intent: object) => ({ ...intent, changed: true, state: "reserved" })),
    authorizeWorkspaceCreate: vi.fn(async () => ({ orgId: "org" })),
    createCloudWorkspace: vi.fn(async (_auth: unknown, args: { workspaceId: string; displayName: string; repoUrl?: string }) => {
      filed.set(args.workspaceId, {
        id: args.workspaceId, org_id: "org", project_id: PROJECT, workspace_name: args.displayName, directory: "/workspace", kind: "cloud",
        ...(args.repoUrl ? { repo_url: args.repoUrl } : {}), created_at: 1, updated_at: 1,
      })
      return { workspace_id: args.workspaceId }
    }),
  }
  const services = {
    authority,
    sandbox: { sandboxManager, orgDriver: async () => ({ ...recordingDriver(secretBrokering, []), id: secretBrokering === "native" ? "cloudflare" : "boat" }) },
    relay: { relayUrls: { "us-east": "https://relay.claxedo.test" } },
    defaultHomeRegion: "us-east",
  } as unknown as ControlPlaneServices
  type DeliveryInput = Parameters<typeof createHostedRuntimeDelivery>[0]
  const delivery = createHostedRuntimeDelivery({
    sandboxRefresh: unusedSandboxStart,
    sandboxRedeliver: unusedSandboxRedeliver,
    idleStop: unusedWorkspaceIdleStop,
    authority: authority as unknown as DeliveryInput["authority"],
    database,
    services,
    sandboxManager,
    workspaceSecretBrokering: async () => secretBrokering,
    broker: createHostedEgressBroker({
      credentials,
      read: (orgId) => hostedBrokerCredentialReader(orgId, { database, env: CREDENTIAL_ENV }),
      workspaceOwner: async () => owner,
      sandboxManager,
      env: signing,
      origin: ORIGIN,
    }),
    sandboxInput: async () => { throw new Error("a root is not started through the workspace routes") },
    settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
    credentials, signingEnv: signing, provisionedRunner: undefined,
  })
  const bridge = createHostedTasksSessionBridge({
    services,
    runtimeClient: {},
    reads: {
      workspace: async (workspaceId) => filed.get(workspaceId),
      projectWorkspaces: async () => [],
      projectSource: async () => ({ repoUrl: REPO, gitBranch: "main" }),
      sessions: async () => new Map(),
    },
    principal: async () => ({ principalKind: "user", actorId: owner.actorId, actorKind: "human" }),
    auth: () => ({ user: { subject: "owner" }, principal: { userId: owner.userId } }) as unknown as SignedControlPlaneAuth,
    selectedCapabilities: {
      prepare: async () => ({}),
      apply: ({ workspaceId, preparation }) => delivery.provisionRuntime({ workspaceId }, preparation),
    },
    workspaceRuntime: delivery.prepareRuntime,
    sandboxEgress: { controlPlaneOrigin: ORIGIN },
  })
  runtimeRequest.mockImplementation(async () => Response.json({
    harness: "claude",
    modelSelection: { status: "optional", models: [] },
  }))
  const previewed = await bridge.preview({
    actor: { scopeId: "org", ownerId: "owner" }, task, preset, slot: "primary", attempt: 1, continueFromPrevious: false,
    currentLink: null, currentState: null, authorizeTranscript: async () => true,
  })
  const snapshot = configApplied.mock.calls.at(-1)?.[0]
  return { previewed, seen, key, snapshot, rootId }
}

test("a task's root on a driver with a provider edge launches with its owner's account on the edge, under the variable its runtime reads", async () => {
  const { previewed, seen, key, snapshot, rootId } = await rootStart("native")
  expect(previewed).toMatchObject({ ok: true, preview: { blockers: [] } })
  expect(seen.map((input) => input.workspaceId)).toEqual([rootId])
  expect(seen[0]?.secrets).toEqual([expect.objectContaining({ name: accountPlaceholderEnv(key), value: "sk-ant-api03-root-owner", hosts: ["api.anthropic.com"] })])
  expect(snapshot?.auth.accounts.owner?.anthropic).toMatchObject({ placeholderEnv: accountPlaceholderEnv(key) })
})

test("a task's root on a driver the plane brokers for gets its owner's account as a binding, and no secret reaches its create", async () => {
  const { previewed, seen, snapshot } = await rootStart("none")
  expect(previewed).toMatchObject({ ok: true, preview: { blockers: [] } })
  expect(seen[0]?.secrets ?? []).toEqual([])
  expect(snapshot?.auth.accounts.owner?.anthropic).toMatchObject({ baseUrl: expect.stringMatching(new RegExp(`^${ORIGIN}/bindings/`)) })
  expect(JSON.stringify(seen)).not.toContain("sk-ant-api03-root-owner")
  expect(JSON.stringify(snapshot)).not.toContain("sk-ant-api03-root-owner")
})
