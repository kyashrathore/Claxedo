/**
 * Turning Tasks off ends the grants already in the sandboxes: the real
 * activation route commits the switch, and the real Tasks routes refuse the
 * capability on the next request. Turning subagents off ends the owner grants
 * the same way, through the same register.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
import type {
  MutateSignedOrganizationDefault,
  MutateSignedUserActivation,
  SignedActivationSnapshot,
  SignedAgentPluginActivationStore,
} from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { BUILTIN_SUBAGENTS_TOOL_GROUP, BUILTIN_TASKS_TOOL_GROUP, builtinPluginInstanceId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import { bearerToken, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { TasksActor, TasksSessionBridgePort } from "@claxedo/tasks"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks/http"
import type { ControlPlaneServices } from "../authority/services"
import { HostedAgentPluginRoutes } from "../agent-plugins/routes"
import { createBuiltinGroupReader } from "../agent-plugins/runtime/cloud-root-environment"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"
import { OWNER_GRANT_AUDIENCE, createOwnerRootGrant, verifyOwnerGrant } from "../session/owner-grant"
import { TASKS_CAPABILITY_AUDIENCE } from "./capability"
import { createGrantWithdrawal } from "./grant-withdrawal"
import { createHostedTasksComposition } from "./hosted-composition"
import { createTasksRootGrant, type TasksRootIdentity } from "./root-capability"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(["0025_claxedo_tasks.sql", "0033_task_child_number.sql"])
  active.push(instance)
  return instance.database
}

const OWNER = { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" }
const ROOT: TasksRootIdentity = { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", sessionId: "ses_1" }
const SIBLING: TasksRootIdentity = { userId: "alice", orgId: "org-1", projectId: "project-b", workspaceId: "ws_other" }
const OWNERS: Record<string, typeof OWNER> = {
  ws_root: OWNER,
  ws_other: { ...OWNER, projectId: "project-b" },
}
const TASKS_ID = builtinPluginInstanceId(BUILTIN_TASKS_TOOL_GROUP)
const SUBAGENTS_ID = builtinPluginInstanceId(BUILTIN_SUBAGENTS_TOOL_GROUP)
const HARNESSES: AgentPluginHarnessId[] = ["opencode", "claude", "codex", "cursor"]

/** The one activation fact this test writes and reads: whether Tasks is on, per project, for alice. */
class ProjectSwitches implements SignedAgentPluginActivationStore {
  revisionValue = 0
  readonly overrides = new Map<string, boolean>()
  readonly organizationDefaults = new Set<string>()

  private snapshot(pluginInstanceId: string, harnessId: AgentPluginHarnessId, projectId?: string): SignedActivationSnapshot {
    const override = projectId === undefined ? undefined : this.overrides.get(`${projectId}:${pluginInstanceId}`)
    return {
      revision: this.revisionValue,
      pluginInstanceId,
      harnessId,
      ...(projectId ? { projectId } : {}),
      ...(override === undefined ? {} : { projectOverride: override }),
      ...(this.organizationDefaults.has(pluginInstanceId) ? { organizationDefault: true as const } : {}),
      pins: {},
    }
  }

  async authorizeProject() {}
  async revision() { return this.revisionValue }
  async listKnown() { return [] }
  async read(_auth: SignedControlPlaneAuth, input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string }) {
    return this.snapshot(input.pluginInstanceId, input.harnessId, input.projectId)
  }
  async readRuntime(input: { projectId: string; pluginInstanceId: string; harnessId: AgentPluginHarnessId }) {
    return this.snapshot(input.pluginInstanceId, input.harnessId, input.projectId)
  }
  async mutateUser(_auth: SignedControlPlaneAuth, input: MutateSignedUserActivation) {
    if (input.target.scope !== "projects") throw new Error("this fixture switches projects only")
    for (const projectId of input.target.projectIds) {
      if (input.choice === undefined) this.overrides.delete(`${projectId}:${input.pluginInstanceId}`)
      else this.overrides.set(`${projectId}:${input.pluginInstanceId}`, input.choice)
    }
    return ++this.revisionValue
  }
  async mutateOrganizationDefault(_auth: SignedControlPlaneAuth, input: MutateSignedOrganizationDefault) {
    if (input.choice === true) this.organizationDefaults.add(input.pluginInstanceId)
    else this.organizationDefaults.delete(input.pluginInstanceId)
    return ++this.revisionValue
  }
  async updateUserArtifact(): Promise<number> { throw new Error("not in this fixture") }
  async updateOrganizationArtifact(): Promise<number> { throw new Error("not in this fixture") }
}

/** Only alice signs in; a capability the Tasks door refuses must not be admitted as a user on the way out. */
function aliceOnlyAuthentication(): RequestAuthenticationAdapter {
  const adapter = testRequestAuthenticationAdapter()
  return {
    descriptor: adapter.descriptor,
    authenticate: async (request) => {
      const bearer = bearerToken(request.headers.get("authorization"))
      if (bearer !== undefined && bearer !== "alice") {
        throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      }
      return await adapter.authenticate(request)
    },
  }
}

function refusingBridge(): TasksSessionBridgePort {
  const refuse = async (_actor: TasksActor) => ({ ok: false as const, error: { code: "unsupported" as const, message: "no bridge" } })
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

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const passes = memorySandboxPassRegister()
  const activations = new ProjectSwitches()
  const builtIn = { groups: claxedoMcpToolGroupInventory(), deployment: { inProcessServices: [] } }
  const services = {
    auth: { config: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" } },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org-1"),
      resolveWorkspaceOwner: vi.fn(async (workspaceId: string) => OWNERS[workspaceId]),
      usersMe: vi.fn(async () => ({ user_id: "alice", org_id: "org-1" })),
      listOrgs: vi.fn(async () => [{ org_id: "org-1", role: "admin" }]),
      listWorkspaces: vi.fn(async () => []),
      authorizeProject: vi.fn(async () => ({ ok: true, role: "admin", orgId: "org-1" })),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  const authentication = aliceOnlyAuthentication()
  const withdrawal = createGrantWithdrawal({
    passes,
    audience: TASKS_CAPABILITY_AUDIENCE,
    reason: "tasks_group_disabled",
    groupEnabled: createBuiltinGroupReader({ activations, builtIn }, BUILTIN_TASKS_TOOL_GROUP),
  })
  const ownerWithdrawal = createGrantWithdrawal({
    passes,
    audience: OWNER_GRANT_AUDIENCE,
    reason: "subagents_group_disabled",
    groupEnabled: createBuiltinGroupReader({ activations, builtIn }, BUILTIN_SUBAGENTS_TOOL_GROUP),
  })
  const plugins = HostedAgentPluginRoutes({
    services,
    authentication,
    sources: () => ({ async listAuthorizedSources() { return [] } }),
    activations,
    artifacts: { put: async () => { throw new Error("no artifacts") }, get: async () => undefined },
    reconcile: { reconcile: async () => ({ state: "scheduled" as const }) },
    builtIn,
    builtInConsentChanged: async (auth, groupId) => {
      if (groupId === BUILTIN_TASKS_TOOL_GROUP) await withdrawal.reconcile(await services.authority!.resolveOrgId(auth))
      if (groupId === BUILTIN_SUBAGENTS_TOOL_GROUP) await ownerWithdrawal.reconcile(await services.authority!.resolveOrgId(auth))
    },
  })
  const tasks = createHostedTasksComposition({
    services,
    database: await database(),
    authentication,
    bridge: refusingBridge,
    signingEnv,
    passes,
  })
  const app = new Hono()
  app.route("/api/claxedo/plugins", plugins)
  for (const contribution of tasks.routeContributions) app.route(contribution.path, contribution.routes)
  const grant = createTasksRootGrant({ signingEnv, passes })
  const ownerGrant = createOwnerRootGrant({ signingEnv, passes, workspaceOwner: async (workspaceId) => OWNERS[workspaceId] })
  const listTasks = (token: string, projectId = "project-a") =>
    app.request(`https://core.test${TASKS_ROUTE_PATH}/tasks?projectId=${projectId}`, { headers: { authorization: `Bearer ${token}` } })
  const activation = (body: Record<string, unknown>, route = "/activation") =>
    app.request(`https://core.test/api/claxedo/plugins${route}`, {
      method: "POST",
      headers: { authorization: "Bearer alice", "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { passes, activations, withdrawal, app, grant, ownerGrant, signingEnv, listTasks, activation }
}

describe("withdrawing the Tasks grants of a project that turned Tasks off", () => {
  test("the switch, written through the real activation route, refuses the root's capability on its next request", async () => {
    const { activations, grant, listTasks, activation } = await fixture()
    activations.overrides.set(`project-a:${TASKS_ID}`, true)
    activations.overrides.set(`project-b:${TASKS_ID}`, true)
    const rootGrant = await grant(ROOT)
    const siblingGrant = await grant(SIBLING)
    expect((await listTasks(rootGrant.token)).status).toBe(200)

    const switched = await activation({
      pluginInstanceId: TASKS_ID,
      harnessIds: HARNESSES,
      choice: false,
      expectedRevision: activations.revisionValue,
      target: { scope: "projects", projectIds: ["project-a"] },
    })
    expect(switched.status).toBe(200)

    const refused = await listTasks(rootGrant.token)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { message: "This request is not signed" } })
    expect((await listTasks(siblingGrant.token, "project-b")).status).toBe(200)
  })

  test("returning a project to a default of off withdraws the same way, and turning Tasks on withdraws nothing", async () => {
    const { activations, passes, grant, listTasks, activation } = await fixture()
    activations.overrides.set(`project-a:${TASKS_ID}`, true)
    const rootGrant = await grant(ROOT)

    const on = await activation({
      pluginInstanceId: TASKS_ID, harnessIds: HARNESSES, choice: true, expectedRevision: activations.revisionValue,
      target: { scope: "projects", projectIds: ["project-a"] },
    })
    expect(on.status).toBe(200)
    expect((await listTasks(rootGrant.token)).status).toBe(200)

    const returned = await activation({
      pluginInstanceId: TASKS_ID, harnessIds: HARNESSES, choice: null, expectedRevision: activations.revisionValue,
      target: { scope: "projects", projectIds: ["project-a"] },
    })
    expect(returned.status).toBe(200)
    expect((await listTasks(rootGrant.token)).status).toBe(401)
    expect(await passes.outstanding({ orgId: "org-1", audience: TASKS_CAPABILITY_AUDIENCE })).toEqual([])
  })

  test("an organization default withdrawn by an admin ends the grants that rested on it", async () => {
    const { activations, grant, listTasks, activation } = await fixture()
    activations.organizationDefaults.add(TASKS_ID)
    const rootGrant = await grant(ROOT)
    expect((await listTasks(rootGrant.token)).status).toBe(200)

    const withdrawn = await activation(
      { pluginInstanceId: TASKS_ID, harnessIds: HARNESSES, choice: null, expectedRevision: activations.revisionValue },
      "/organization-default",
    )
    expect(withdrawn.status).toBe(200)
    expect((await listTasks(rootGrant.token)).status).toBe(401)
  })

  test("turning subagents off ends the owner grants and leaves the Tasks grants standing; turning Tasks off does the reverse", async () => {
    const { activations, passes, grant, ownerGrant, signingEnv, listTasks, activation } = await fixture()
    activations.overrides.set(`project-a:${TASKS_ID}`, true)
    const tasksGrant = await grant(ROOT)
    const owner = await ownerGrant(ROOT)
    const verifyOwner = () => verifyOwnerGrant(owner.token, signingEnv, { revoked: passes.revoked })
    await expect(verifyOwner()).resolves.toMatchObject({ workspaceId: ROOT.workspaceId })

    const subagentsOff = await activation({
      pluginInstanceId: SUBAGENTS_ID, harnessIds: HARNESSES, choice: false, expectedRevision: activations.revisionValue,
      target: { scope: "projects", projectIds: ["project-a"] },
    })
    expect(subagentsOff.status).toBe(200)
    await expect(verifyOwner()).rejects.toThrow("was revoked")
    expect((await listTasks(tasksGrant.token)).status).toBe(200)
    expect(await passes.outstanding({ orgId: "org-1", audience: OWNER_GRANT_AUDIENCE })).toEqual([])

    const nextOwner = await ownerGrant(SIBLING)
    const tasksOff = await activation({
      pluginInstanceId: TASKS_ID, harnessIds: HARNESSES, choice: false, expectedRevision: activations.revisionValue,
      target: { scope: "projects", projectIds: ["project-a"] },
    })
    expect(tasksOff.status).toBe(200)
    expect((await listTasks(tasksGrant.token)).status).toBe(401)
    await expect(verifyOwnerGrant(nextOwner.token, signingEnv, { revoked: passes.revoked })).resolves.toMatchObject({ workspaceId: SIBLING.workspaceId })
  })

  test("a deleted workspace takes every pass minted for it, whatever the audience", async () => {
    const { activations, passes, grant, ownerGrant, signingEnv, listTasks } = await fixture()
    activations.overrides.set(`project-a:${TASKS_ID}`, true)
    const rootGrant = await grant(ROOT)
    const owner = await ownerGrant(ROOT)
    await passes.revoke({ workspaceId: ROOT.workspaceId, reason: "workspace_deleted" })
    expect((await listTasks(rootGrant.token)).status).toBe(401)
    await expect(verifyOwnerGrant(owner.token, signingEnv, { revoked: passes.revoked })).rejects.toThrow("was revoked")
    expect(await passes.outstanding({ orgId: "org-1", audience: TASKS_CAPABILITY_AUDIENCE })).toEqual([])
    expect(await passes.outstanding({ orgId: "org-1", audience: OWNER_GRANT_AUDIENCE })).toEqual([])
  })

  test("a root whose activation can no longer be read is treated as off", async () => {
    const passes = memorySandboxPassRegister()
    const withdrawal = createGrantWithdrawal({
      passes,
      audience: TASKS_CAPABILITY_AUDIENCE,
      reason: "tasks_group_disabled",
      groupEnabled: async () => { throw new Error("workspace not found") },
    })
    await passes.record({ jti: "j1", audience: TASKS_CAPABILITY_AUDIENCE, scope: ROOT, issuedAt: 1, expiresAt: Date.now() + 60_000 })
    expect(await withdrawal.reconcile("org-1")).toEqual(["ws_root"])
    expect(await passes.revoked("j1")).toBe(true)
  })
})
