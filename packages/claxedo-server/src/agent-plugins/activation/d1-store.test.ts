import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { AgentPluginActivationStoreError } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginArtifactPin } from "@claxedo/server-core/agent-plugins/activation/store"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import {
  AGENT_PLUGIN_ALL_PROJECTS_SCOPE,
  AGENT_PLUGIN_DESKTOP_WORKSPACE,
  D1SignedAgentPluginActivationStore,
} from "./d1-store"

// The store reads and writes canonical authority rows, so the harness applies
// the same control-plane migrations a hosted deployment runs and builds real
// identities, organizations, projects, and workspaces through the authority.
const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0013_org_team_session_sharing.sql",
  "0017_adapter_custom.sql",
  "0018_drop_agent_extensions.sql",
  "0019_agent_plugin_activations.sql",
]

const PLUGIN = "claxedo/review"
const OTHER_PLUGIN = "claxedo/triage"
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

function digest(fill: string): ArtifactDigest {
  return `sha256:${fill.repeat(64)}`
}

function artifact(fill: string, sourceRevision = "commit-1"): AgentPluginArtifactPin {
  return { digest: digest(fill), sourceId: "claxedo", relativePath: "review", sourceRevision }
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://better-auth.example.test", subject }
}

async function migrate(database: D1Database) {
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
}

async function setup() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await migrate(database)
  let sequence = 0
  const authority = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now: () => 1_800_000_000_000 + sequence,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const store = new D1SignedAgentPluginActivationStore({ database, authority })
  return { database, authority, store }
}

async function signed(
  authority: D1WorkspaceAuthority,
  applicationIdentity: AuthIdentity,
): Promise<SignedControlPlaneAuth> {
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${applicationIdentity.subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity: applicationIdentity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject: applicationIdentity.subject,
      tokenIdentifier: `${applicationIdentity.issuer}|${applicationIdentity.subject}`,
      issuer: applicationIdentity.issuer,
    },
  }
}

async function principalOf(authority: D1WorkspaceAuthority, auth: SignedControlPlaneAuth) {
  const me = await authority.usersMe(auth)
  return { userId: me.user_id, orgId: await authority.resolveOrgId(auth) }
}

/**
 * A plain organization member. There is no authority method for org invites, so
 * the membership row is seeded directly and the member's own personal
 * organization is retired to keep `usersMe` unambiguous.
 */
async function plainMember(input: {
  database: D1Database
  authority: D1WorkspaceAuthority
  subject: string
  orgId: string
}) {
  const auth = await signed(input.authority, identity(input.subject))
  const me = await input.authority.usersMe(auth)
  await input.database
    .prepare(`update orgs set deleted_at = 1 where owner_user_id = ? and kind = 'personal'`)
    .bind(me.user_id)
    .run()
  await input.database
    .prepare(`
      insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
      values (?, ?, 'member', 1, 1, null)
    `)
    .bind(input.orgId, me.user_id)
    .run()
  return { auth, userId: me.user_id }
}

async function workspace(input: {
  authority: D1WorkspaceAuthority
  auth: SignedControlPlaneAuth
  orgId: string
  workspaceId: string
  access: "cloud" | "user-hosted"
}) {
  return await input.authority.createWorkspace(input.auth, {
    workspaceId: input.workspaceId,
    orgId: input.orgId,
    displayName: input.workspaceId,
    repoUrl: `https://github.com/claxedo/${input.workspaceId}.git`,
    backing: input.access === "cloud" ? "cloud-vm" : "local-worktree",
    access: input.access,
  })
}

async function rejection(promise: Promise<unknown>) {
  let failure: unknown
  await promise.then(
    () => undefined,
    (cause: unknown) => {
      failure = cause
    },
  )
  if (failure === undefined) throw new Error("expected a rejection")
  return failure
}

async function denial(promise: Promise<unknown>) {
  const failure = await rejection(promise)
  if (!(failure instanceof ControlPlaneAuthError)) throw failure
  return failure
}

async function storeFailure(promise: Promise<unknown>) {
  const failure = await rejection(promise)
  if (!(failure instanceof AgentPluginActivationStoreError)) throw failure
  return failure
}

describe("D1 signed Agent Plugins activation store", () => {
  test("starts an organization at revision 0 with nothing retained", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))

    expect(await store.revision(auth)).toBe(0)
    expect(await store.listKnown(auth)).toEqual([])
    expect(await store.read(auth, { pluginInstanceId: PLUGIN, harnessId: "codex" })).toEqual({
      revision: 0,
      pluginInstanceId: PLUGIN,
      harnessId: "codex",
      pins: {},
    })
  })

  test("commits an all-projects user default with its artifact pin", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))

    const revision = await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex", "opencode"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })

    expect(revision).toBe(1)
    expect(await store.listKnown(auth)).toEqual([
      { pluginInstanceId: PLUGIN, pins: { user: artifact("a") } },
    ])
    expect(await store.read(auth, { pluginInstanceId: PLUGIN, harnessId: "codex" })).toEqual({
      revision: 1,
      pluginInstanceId: PLUGIN,
      harnessId: "codex",
      userDefault: true,
      pins: { user: digest("a") },
    })
    expect(await store.read(auth, { pluginInstanceId: PLUGIN, harnessId: "cursor" })).toEqual({
      revision: 1,
      pluginInstanceId: PLUGIN,
      harnessId: "cursor",
      pins: { user: digest("a") },
    })
  })

  test("writes project overrides only for the listed projects", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const { orgId } = await principalOf(authority, auth)
    const first = await workspace({ authority, auth, orgId, workspaceId: "ws-one", access: "cloud" })
    const second = await workspace({ authority, auth, orgId, workspaceId: "ws-two", access: "cloud" })

    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "projects", projectIds: [first.project_id] },
      artifact: artifact("a"),
      expectedRevision: 0,
    })

    const enabled = await store.read(auth, {
      pluginInstanceId: PLUGIN,
      harnessId: "codex",
      projectId: first.project_id,
    })
    expect(enabled.projectOverride).toBe(true)
    expect(enabled.projectId).toBe(first.project_id)
    const untouched = await store.read(auth, {
      pluginInstanceId: PLUGIN,
      harnessId: "codex",
      projectId: second.project_id,
    })
    expect(untouched.projectOverride).toBeUndefined()
    expect(untouched.userDefault).toBeUndefined()
  })

  test("denies a project the signed user cannot write", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const other = await signed(authority, identity("mallory"))
    const { orgId } = await principalOf(authority, other)
    const foreign = await workspace({
      authority,
      auth: other,
      orgId,
      workspaceId: "ws-foreign",
      access: "cloud",
    })

    const failure = await denial(store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "projects", projectIds: [foreign.project_id] },
      artifact: artifact("a"),
      expectedRevision: 0,
    }))

    expect(failure.status).toBe(403)
    expect(failure.code).toBe("workspace_authorization_denied")
    expect(await store.revision(auth)).toBe(0)
    expect(await denial(store.authorizeProject(auth, foreign.project_id))).toBeInstanceOf(ControlPlaneAuthError)
  })

  test("refuses to enable a plugin with no retained artifact", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))

    const failure = await storeFailure(store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      expectedRevision: 0,
    }))

    expect(failure.code).toBe("artifact-unavailable")
    expect(await store.revision(auth)).toBe(0)
  })

  test("rejects a stale expected revision", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })

    const failure = await storeFailure(store.mutateUser(auth, {
      pluginInstanceId: OTHER_PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("b"),
      expectedRevision: 0,
    }))

    expect(failure.code).toBe("revision-conflict")
    expect(failure.message).toBe("Agent plugin activation revision changed from 0 to 1")
    expect(await store.revision(auth)).toBe(1)
  })

  test("lets exactly one of two concurrent mutations land", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const mutation = (pluginInstanceId: string, fill: string) => store.mutateUser(auth, {
      pluginInstanceId,
      harnessIds: ["codex" as const],
      choice: true,
      target: { scope: "all-projects" as const },
      artifact: artifact(fill),
      expectedRevision: 0,
    })

    const results = await Promise.allSettled([mutation(PLUGIN, "a"), mutation(OTHER_PLUGIN, "b")])

    const landed = results.filter((result) => result.status === "fulfilled")
    const refused = results.filter((result) => result.status === "rejected")
    expect(landed.map((result) => result.value)).toEqual([1])
    expect(refused).toHaveLength(1)
    expect(refused[0].reason).toBeInstanceOf(AgentPluginActivationStoreError)
    expect(refused[0].reason.code).toBe("revision-conflict")
    expect(await store.revision(auth)).toBe(1)
    // The loser's artifact pin is rolled back with its guarded batch.
    expect(await store.listKnown(auth)).toHaveLength(1)
  })

  test("replays an exact retry instead of bumping the revision again", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const input = {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex" as const],
      choice: true,
      target: { scope: "all-projects" as const },
      artifact: artifact("a"),
      expectedRevision: 0,
    }

    const first = await store.mutateUser(auth, input)
    const retry = await store.mutateUser(auth, input)

    expect(first).toBe(1)
    expect(retry).toBe(1)
    expect(await store.revision(auth)).toBe(1)
  })

  test("keeps organization defaults to organization administrators", async () => {
    const { database, authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    const { orgId } = await principalOf(authority, owner)
    const member = await plainMember({ database, authority, subject: "bob", orgId })

    const failure = await denial(store.mutateOrganizationDefault(member.auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      artifact: artifact("a"),
      expectedRevision: 0,
    }))
    expect(failure.status).toBe(403)
    expect(await store.revision(owner)).toBe(0)

    const revision = await store.mutateOrganizationDefault(owner, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      artifact: artifact("a"),
      expectedRevision: 0,
    })

    expect(revision).toBe(1)
    const snapshot = await store.read(member.auth, { pluginInstanceId: PLUGIN, harnessId: "codex" })
    expect(snapshot.organizationDefault).toBe(true)
    expect(snapshot.pins).toEqual({ organization: digest("a") })
  })

  test("updates a retained user artifact only when one exists", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))

    const missing = await storeFailure(store.updateUserArtifact(auth, {
      pluginInstanceId: PLUGIN,
      artifact: artifact("b", "commit-2"),
      expectedRevision: 0,
    }))
    expect(missing.code).toBe("artifact-unavailable")

    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })
    const revision = await store.updateUserArtifact(auth, {
      pluginInstanceId: PLUGIN,
      artifact: artifact("b", "commit-2"),
      expectedRevision: 1,
    })

    expect(revision).toBe(2)
    expect(await store.listKnown(auth)).toEqual([
      { pluginInstanceId: PLUGIN, pins: { user: artifact("b", "commit-2") } },
    ])
  })

  test("rechecks the runtime principal before returning activation", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const outsider = await signed(authority, identity("mallory"))
    const { userId, orgId } = await principalOf(authority, auth)
    const created = await workspace({ authority, auth, orgId, workspaceId: "ws-one", access: "cloud" })
    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })
    const runtime = {
      organizationId: orgId,
      projectId: created.project_id,
      workspaceId: created.workspace_id,
      pluginInstanceId: PLUGIN,
      harnessId: "codex" as AgentPluginHarnessId,
    }

    const owned = await store.readRuntime({ ...runtime, ownerUserId: userId })
    expect(owned.userDefault).toBe(true)
    expect(owned.pins).toEqual({ user: digest("a") })

    const outside = await principalOf(authority, outsider)
    const failure = await denial(store.readRuntime({ ...runtime, ownerUserId: outside.userId }))
    expect(failure.status).toBe(403)
    const foreignWorkspace = await denial(store.readRuntime({
      ...runtime,
      ownerUserId: userId,
      workspaceId: "ws-unknown",
    }))
    expect(foreignWorkspace.code).toBe("workspace_authorization_denied")
  })

  test("serves the runtime world of a cloud workspace and refuses a user-hosted one", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const { userId, orgId } = await principalOf(authority, auth)
    const cloud = await workspace({ authority, auth, orgId, workspaceId: "ws-cloud", access: "cloud" })
    const local = await workspace({ authority, auth, orgId, workspaceId: "ws-local", access: "user-hosted" })
    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })

    const snapshot = await store.runtimeSnapshot(cloud.workspace_id)
    expect(snapshot.identity).toEqual({
      userId,
      organizationId: orgId,
      projectId: cloud.project_id,
      workspaceId: cloud.workspace_id,
    })
    expect(snapshot.revision).toBe(1)
    expect(snapshot.plugins).toHaveLength(1)
    expect(snapshot.plugins[0].harnesses.codex.userDefault).toBe(true)
    expect(snapshot.plugins[0].harnesses.codex.projectId).toBe(cloud.project_id)
    expect(snapshot.plugins[0].harnesses.cursor.userDefault).toBeUndefined()

    await expect(store.runtimeSnapshot(local.workspace_id)).rejects.toThrow(
      "Agent Plugins cloud workspace not found",
    )
  })

  test("serves the signed user's all-projects world without any project override", async () => {
    const { authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const { userId, orgId } = await principalOf(authority, auth)
    const created = await workspace({ authority, auth, orgId, workspaceId: "ws-one", access: "cloud" })
    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    })
    await store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      harnessIds: ["codex"],
      choice: false,
      target: { scope: "projects", projectIds: [created.project_id] },
      expectedRevision: 1,
    })

    const snapshot = await store.runtimeSnapshotForUser(auth)

    expect(snapshot.identity).toEqual({
      userId,
      organizationId: orgId,
      projectId: AGENT_PLUGIN_ALL_PROJECTS_SCOPE,
      workspaceId: AGENT_PLUGIN_DESKTOP_WORKSPACE,
    })
    expect(snapshot.plugins[0].harnesses.codex.projectOverride).toBeUndefined()
    expect(snapshot.plugins[0].harnesses.codex.projectId).toBeUndefined()
    expect(snapshot.plugins[0].harnesses.codex.userDefault).toBe(true)
    // The same read scoped to that project still sees the explicit "off".
    const scoped = await store.read(auth, {
      pluginInstanceId: PLUGIN,
      harnessId: "codex",
      projectId: created.project_id,
    })
    expect(scoped.projectOverride).toBe(false)
  })

  test("rejects an unknown harness before writing anything", async () => {
    const { database, authority, store } = await setup()
    const auth = await signed(authority, identity("alice"))
    const unknownHarnesses: string[] = ["vim"]

    const failure = await storeFailure(store.mutateUser(auth, {
      pluginInstanceId: PLUGIN,
      // The typed contract cannot express an unknown harness; the store still
      // has to refuse one that reaches it from an untyped route body.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      harnessIds: unknownHarnesses as AgentPluginHarnessId[],
      choice: true,
      target: { scope: "all-projects" },
      artifact: artifact("a"),
      expectedRevision: 0,
    }))

    expect(failure.code).toBe("unsupported-harness")
    expect(await store.revision(auth)).toBe(0)
    const pins = await database
      .prepare("select count(*) as count from agent_plugin_artifact_pins")
      .first<{ count: number }>()
    expect(pins?.count).toBe(0)
  })
})
