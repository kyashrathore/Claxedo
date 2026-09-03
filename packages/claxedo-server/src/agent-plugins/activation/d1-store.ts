import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  AgentPluginActivationStoreError,
  type AgentPluginArtifactPin,
  type MutateSignedOrganizationDefault,
  type MutateSignedUserActivation,
  type SignedActivationSnapshot,
  type SignedAgentPluginActivationStore,
  type SignedKnownPlugin,
  type UpdateSignedArtifactPin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import {
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { OrgId, ProjectId, WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SignedAgentPluginRuntimeSnapshot } from "../runtime/provision"

/** The project scope a user default addresses; never a real project ID. */
export const AGENT_PLUGIN_ALL_PROJECTS_SCOPE = "all-projects"

/** The workspace a signed desktop pull materializes into; never a real workspace ID. */
export const AGENT_PLUGIN_DESKTOP_WORKSPACE = "desktop"

const CLAXEDO_SCOPE_KEY = "claxedo"
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/

/**
 * The authority capabilities this store consumes. Signed methods resolve the
 * canonical user and organization through these; no caller-supplied owner or
 * organization ID ever reaches a statement below.
 */
export type AgentPluginActivationAuthority = Pick<
  WorkspaceAuthority,
  "usersMe" | "resolveOrgId" | "authorizeProject" | "listOrgs"
>

export type D1SignedAgentPluginActivationStoreInput = {
  database: D1Database
  authority: AgentPluginActivationAuthority
  now?: () => number
}

type Scope = {
  userId: string
  orgId: string
}

type RevisionRow = {
  revision: number
  last_operation_id: string | null
  last_operation_revision: number | null
}

type PinRow = {
  plugin_instance_id: string
  artifact_digest: string
  source_id: string
  relative_path: string
  source_revision: string
}

type EnabledRow = {
  enabled: number
}

type PresenceRow = {
  present: number
}

type InstanceRow = {
  plugin_instance_id: string
}

type ProjectAccessRow = {
  org_id: string
  role_rank: number
}

type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: string
  access: string
  role_rank: number
}

type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: string
  access: string
}

/**
 * Membership, project, and workspace SQL owned by `D1WorkspaceAuthority`.
 *
 * The runtime reads below carry an audience-bound token instead of a signed
 * bearer, so they cannot go through the authority port and must evaluate the
 * same canonical rows themselves. These three shapes are kept identical to
 * `activeOrgMembership`, `projectAccess`, and `workspaceAccessSql` in
 * `authority/adapters/d1/workspace-authority.ts`; a divergence there is a
 * divergence in what a runtime token may read.
 */
const ORG_MEMBERSHIP_SQL = `
  select 1 as present from orgs o
  left join org_memberships m
    on m.org_id = o.org_id and m.user_id = ? and m.revoked_at is null
  where o.org_id = ? and o.deleted_at is null and (o.owner_user_id = ? or m.user_id is not null)
`

const PROJECT_ACCESS_SQL = `
  select p.org_id,
    max(
      case when p.owner_user_id = ? then 4 else 0 end,
      coalesce(case pm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      coalesce((
        select max(case tg.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 end)
        from team_project_grants tg
        join team_memberships tm
          on tm.team_id = tg.team_id and tm.user_id = ? and tm.revoked_at is null
        join teams t on t.team_id = tg.team_id and t.org_id = p.org_id and t.deleted_at is null
        where tg.project_id = p.project_id and tg.revoked_at is null
      ), 0),
      case when o.owner_user_id = ? then 3
        when om.role in ('owner', 'admin') then 3
        when om.role = 'member' then 1 else 0 end
    ) as role_rank
  from projects p
  join orgs o on o.org_id = p.org_id and o.deleted_at is null
  left join project_memberships pm
    on pm.project_id = p.project_id and pm.user_id = ? and pm.revoked_at is null
  left join org_memberships om
    on om.org_id = p.org_id and om.user_id = ? and om.revoked_at is null
  where p.project_id = ? and p.deleted_at is null and (? is null or p.org_id = ?)
    and (o.owner_user_id = ? or om.user_id is not null)
`

const WORKSPACE_ACCESS_SQL = `
  select w.workspace_id, w.org_id, w.project_id, w.owner_user_id, w.backing, w.access,
    max(
      case when w.owner_user_id = ? then 4 else 0 end,
      coalesce(case wm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      coalesce(case pm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      coalesce((
        select max(case tg.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 end)
        from team_project_grants tg
        join team_memberships tm
          on tm.team_id = tg.team_id and tm.user_id = ? and tm.revoked_at is null
        join teams t on t.team_id = tg.team_id and t.org_id = w.org_id and t.deleted_at is null
        where tg.project_id = w.project_id and tg.revoked_at is null
      ), 0),
      case when o.owner_user_id = ? then 3
        when om.role in ('owner', 'admin') then 3
        when om.role = 'member' then 1 else 0 end
    ) as role_rank
  from workspaces w
  join projects p on p.project_id = w.project_id and p.org_id = w.org_id and p.deleted_at is null
  join orgs o on o.org_id = w.org_id and o.deleted_at is null
  left join workspace_memberships wm
    on wm.workspace_id = w.workspace_id and wm.user_id = ? and wm.revoked_at is null
  left join project_memberships pm
    on pm.project_id = w.project_id and pm.user_id = ? and pm.revoked_at is null
  left join org_memberships om
    on om.org_id = w.org_id and om.user_id = ? and om.revoked_at is null
  where w.workspace_id = ? and w.deleted_at is null
    and (o.owner_user_id = ? or om.user_id is not null)
`

const PIN_COLUMNS = "plugin_instance_id, artifact_digest, source_id, relative_path, source_revision"

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function invalid(detail: string): never {
  throw new Error(`D1 returned an invalid Agent Plugins ${detail}`)
}

function text(value: unknown, detail: string) {
  if (typeof value !== "string" || !value) invalid(detail)
  return value
}

function revisionNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("revision")
  return value
}

function roleRank(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("access rank")
  return value
}

function enabled(value: unknown) {
  if (value !== 0 && value !== 1) invalid("activation choice")
  return value === 1
}

function isArtifactDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && ARTIFACT_DIGEST.test(value)
}

function artifactPin(row: PinRow | null): AgentPluginArtifactPin | undefined {
  if (!row) return undefined
  if (!isArtifactDigest(row.artifact_digest)) invalid("artifact digest")
  return {
    digest: row.artifact_digest,
    sourceId: text(row.source_id, "artifact source"),
    relativePath: text(row.relative_path, "artifact path"),
    sourceRevision: text(row.source_revision, "artifact source revision"),
  }
}

function denied(message: string) {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function conflict(expected: number, current: number) {
  return new AgentPluginActivationStoreError(
    "revision-conflict",
    `Agent plugin activation revision changed from ${expected} to ${current}`,
  )
}

function artifactUnavailable() {
  return new AgentPluginActivationStoreError(
    "artifact-unavailable",
    "The selected authority has no retained plugin artifact",
  )
}

function requireHarness(value: string): AgentPluginHarnessId {
  if (!isAgentPluginHarnessId(value)) {
    throw new AgentPluginActivationStoreError(
      "unsupported-harness",
      `${value} is not a supported Agent Plugins harness`,
    )
  }
  return value
}

/** Rejects the whole mutation before any statement is built, never row by row. */
function requireHarnesses(values: readonly string[]) {
  const harnessIds: AgentPluginHarnessId[] = []
  for (const value of new Set(values)) harnessIds.push(requireHarness(value))
  return harnessIds
}

function userScopeKey(orgId: string, ownerUserId: string) {
  return `${orgId}:user:${ownerUserId}`
}

function organizationScopeKey(orgId: string) {
  return `${orgId}:organization`
}

/**
 * The idempotency key the routes' exact network retry reuses.
 *
 * The name and argument shapes are the ones the retired Convex adapter sent, so
 * a retry that crosses this migration still replays instead of double-bumping.
 */
async function operationId(name: string, args: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify([name, args]))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return `agent-plugins-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function assertionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `assert_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`
}

function assertionFailed(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  if (cause.message.includes("passed = 1")) return true
  return assertionFailed(cause.cause)
}

/**
 * Durable signed Agent Plugins metadata over the control-plane database.
 *
 * Every mutation is one D1 batch whose last guarded statement asserts the
 * revision compare-and-set landed, so a concurrent writer aborts the batch
 * rather than interleaving pins and choices from two operations.
 */
export class D1SignedAgentPluginActivationStore implements SignedAgentPluginActivationStore {
  private readonly database: D1Database
  private readonly authority: AgentPluginActivationAuthority
  private readonly now: () => number

  constructor(input: D1SignedAgentPluginActivationStoreInput) {
    this.database = input.database
    this.authority = input.authority
    this.now = input.now ?? Date.now
  }

  async authorizeProject(auth: SignedControlPlaneAuth, projectId: string) {
    const scope = await this.scope(auth)
    await this.requireProject(auth, scope, projectId, "read")
  }

  async revision(auth: SignedControlPlaneAuth) {
    const scope = await this.scope(auth)
    return await this.currentRevision(scope.orgId)
  }

  async listKnown(auth: SignedControlPlaneAuth) {
    const scope = await this.scope(auth)
    return await this.knownPlugins(scope)
  }

  async read(
    auth: SignedControlPlaneAuth,
    input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string },
  ): Promise<SignedActivationSnapshot> {
    const harnessId = requireHarness(input.harnessId)
    const scope = await this.scope(auth)
    if (input.projectId) await this.requireProject(auth, scope, input.projectId, "read")
    return await this.snapshot(scope, input.pluginInstanceId, harnessId, input.projectId)
  }

  async mutateUser(auth: SignedControlPlaneAuth, input: MutateSignedUserActivation) {
    const harnessIds = requireHarnesses(input.harnessIds)
    const scope = await this.scope(auth)
    const projectIds = input.target.scope === "projects" ? [...new Set(input.target.projectIds)] : []
    for (const projectId of projectIds) await this.requireProject(auth, scope, projectId, "write")
    const operation = await operationId("mutateUser", {
      plugin_instance_id: input.pluginInstanceId,
      harness_ids: input.harnessIds,
      choice: input.choice,
      target: input.target.scope === "all-projects"
        ? { scope: "all-projects" }
        : { scope: "projects", project_ids: input.target.projectIds },
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    })
    const started = await this.begin(scope.orgId, input.expectedRevision, operation)
    if ("replay" in started) return started.replay
    const scopeKey = userScopeKey(scope.orgId, scope.userId)
    if (input.choice === true && !input.artifact && !(await this.pinRow(scopeKey, input.pluginInstanceId))) {
      throw artifactUnavailable()
    }
    const now = this.now()
    const writes: D1PreparedStatement[] = []
    if (input.artifact) {
      writes.push(this.writePin({
        scopeKey,
        authority: "user",
        orgId: scope.orgId,
        ownerUserId: scope.userId,
        pluginInstanceId: input.pluginInstanceId,
        artifact: input.artifact,
        now,
      }))
    }
    for (const harnessId of harnessIds) {
      if (input.target.scope === "all-projects") {
        writes.push(this.writeUserDefault({ scope, pluginInstanceId: input.pluginInstanceId, harnessId, choice: input.choice, now }))
        continue
      }
      for (const projectId of projectIds) {
        writes.push(this.writeProjectOverride({
          scope,
          projectId,
          pluginInstanceId: input.pluginInstanceId,
          harnessId,
          choice: input.choice,
          now,
        }))
      }
    }
    return await this.commit(scope.orgId, started.revision, operation, writes)
  }

  async mutateOrganizationDefault(auth: SignedControlPlaneAuth, input: MutateSignedOrganizationDefault) {
    const harnessIds = requireHarnesses(input.harnessIds)
    const scope = await this.scope(auth)
    await this.requireOrganizationAdmin(auth, scope)
    const operation = await operationId("mutateOrganizationDefault", {
      plugin_instance_id: input.pluginInstanceId,
      harness_ids: input.harnessIds,
      choice: input.choice,
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    })
    const started = await this.begin(scope.orgId, input.expectedRevision, operation)
    if ("replay" in started) return started.replay
    const scopeKey = organizationScopeKey(scope.orgId)
    if (input.choice === true && !input.artifact && !(await this.pinRow(scopeKey, input.pluginInstanceId))) {
      throw artifactUnavailable()
    }
    const now = this.now()
    const writes: D1PreparedStatement[] = []
    if (input.artifact) {
      writes.push(this.writePin({
        scopeKey,
        authority: "organization",
        orgId: scope.orgId,
        ownerUserId: null,
        pluginInstanceId: input.pluginInstanceId,
        artifact: input.artifact,
        now,
      }))
    }
    for (const harnessId of harnessIds) {
      writes.push(input.choice === undefined
        ? this.database
            .prepare(`
              delete from agent_plugin_organization_defaults
              where org_id = ? and plugin_instance_id = ? and harness_id = ?
            `)
            .bind(scope.orgId, input.pluginInstanceId, harnessId)
        // An existing default keeps its `updated_at`: re-affirming an
        // organization default is not a change to it.
        : this.database
            .prepare(`
              insert into agent_plugin_organization_defaults (org_id, plugin_instance_id, harness_id, updated_at)
              values (?, ?, ?, ?)
              on conflict (org_id, plugin_instance_id, harness_id) do nothing
            `)
            .bind(scope.orgId, input.pluginInstanceId, harnessId, now))
    }
    return await this.commit(scope.orgId, started.revision, operation, writes)
  }

  async updateUserArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    return await this.updateArtifact(auth, "user", input)
  }

  async updateOrganizationArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    return await this.updateArtifact(auth, "organization", input)
  }

  /**
   * Activation for one audience-bound runtime credential.
   *
   * The caller holds no signed bearer, so the canonical user, organization,
   * project, and workspace relationship is rechecked here before any row is
   * returned.
   */
  async readRuntime(input: {
    ownerUserId: string
    organizationId: string
    projectId: string
    workspaceId: string
    pluginInstanceId: string
    harnessId: AgentPluginHarnessId
  }): Promise<SignedActivationSnapshot> {
    const harnessId = requireHarness(input.harnessId)
    await this.requireRuntimeAccess(input)
    return await this.snapshot(
      { userId: input.ownerUserId, orgId: input.organizationId },
      input.pluginInstanceId,
      harnessId,
      input.projectId,
    )
  }

  /** The whole desired world of one cloud workspace, from its canonical owner. */
  async runtimeSnapshot(workspaceId: string): Promise<SignedAgentPluginRuntimeSnapshot> {
    const workspace = await this.database
      .prepare(`
        select workspace_id, org_id, project_id, owner_user_id, backing, access
        from workspaces where workspace_id = ? and deleted_at is null
      `)
      .bind(workspaceId)
      .first<WorkspaceRow>()
    if (!workspace || workspace.backing !== "cloud-vm" || workspace.access !== "cloud") {
      throw new Error("Agent Plugins cloud workspace not found")
    }
    const identity = {
      userId: text(workspace.owner_user_id, "runtime owner"),
      organizationId: text(workspace.org_id, "runtime organization"),
      projectId: text(workspace.project_id, "runtime project"),
      workspaceId,
    }
    await this.requireRuntimeAccess({
      ownerUserId: identity.userId,
      organizationId: identity.organizationId,
      projectId: identity.projectId,
      workspaceId,
    })
    return await this.world(
      { userId: identity.userId, orgId: identity.organizationId },
      identity,
      identity.projectId,
    )
  }

  /**
   * The signed user's all-projects world, for the desktop pull.
   *
   * No project is in scope, so project overrides are absent by construction and
   * the user, organization, and Claxedo authorities decide every harness.
   */
  async runtimeSnapshotForUser(auth: SignedControlPlaneAuth): Promise<SignedAgentPluginRuntimeSnapshot> {
    const scope = await this.scope(auth)
    return await this.world(scope, {
      userId: scope.userId,
      organizationId: scope.orgId,
      projectId: AGENT_PLUGIN_ALL_PROJECTS_SCOPE,
      workspaceId: AGENT_PLUGIN_DESKTOP_WORKSPACE,
    })
  }

  private async updateArtifact(
    auth: SignedControlPlaneAuth,
    authority: "user" | "organization",
    input: UpdateSignedArtifactPin,
  ) {
    const scope = await this.scope(auth)
    if (authority === "organization") await this.requireOrganizationAdmin(auth, scope)
    const operation = await operationId("updatePin", {
      authority,
      plugin_instance_id: input.pluginInstanceId,
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    })
    const started = await this.begin(scope.orgId, input.expectedRevision, operation)
    if ("replay" in started) return started.replay
    const scopeKey = authority === "user"
      ? userScopeKey(scope.orgId, scope.userId)
      : organizationScopeKey(scope.orgId)
    if (!(await this.pinRow(scopeKey, input.pluginInstanceId))) throw artifactUnavailable()
    return await this.commit(scope.orgId, started.revision, operation, [
      this.writePin({
        scopeKey,
        authority,
        orgId: scope.orgId,
        ownerUserId: authority === "user" ? scope.userId : null,
        pluginInstanceId: input.pluginInstanceId,
        artifact: input.artifact,
        now: this.now(),
      }),
    ])
  }

  private async scope(auth: SignedControlPlaneAuth): Promise<Scope> {
    const me = await this.authority.usersMe(auth)
    if (!record(me)) invalid("principal")
    const userId = text(me.user_id, "principal")
    const orgId = typeof me.org_id === "string" && me.org_id
      ? me.org_id
      : await this.authority.resolveOrgId(auth)
    return { userId, orgId }
  }

  private async requireProject(
    auth: SignedControlPlaneAuth,
    scope: Scope,
    projectId: string,
    action: "read" | "write",
  ) {
    // The authority port brands its organization and project IDs; these two
    // came from that same authority, so the brand is restored rather than
    // invented.
    const result = await this.authority.authorizeProject(auth, {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      orgId: scope.orgId as OrgId,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      projectId: projectId as ProjectId,
      action,
    })
    if (!result.ok) throw denied("Agent Plugins project access denied")
  }

  private async requireOrganizationAdmin(auth: SignedControlPlaneAuth, scope: Scope) {
    const orgs = await this.authority.listOrgs(auth)
    if (!Array.isArray(orgs)) invalid("organization list")
    const administrator = orgs.some((row) => record(row)
      && row.org_id === scope.orgId
      && (row.role === "owner" || row.role === "admin"))
    if (!administrator) throw denied("Agent Plugins organization admin access required")
  }

  private async requireRuntimeAccess(input: {
    ownerUserId: string
    organizationId: string
    projectId: string
    workspaceId: string
  }) {
    const { ownerUserId, organizationId, projectId, workspaceId } = input
    const [user, membership, project, workspace] = await Promise.all([
      this.database
        .prepare(`select 1 as present from users where user_id = ? and state = 'active'`)
        .bind(ownerUserId)
        .first<PresenceRow>(),
      this.database.prepare(ORG_MEMBERSHIP_SQL).bind(ownerUserId, organizationId, ownerUserId).first<PresenceRow>(),
      this.database
        .prepare(PROJECT_ACCESS_SQL)
        .bind(
          ownerUserId,
          ownerUserId,
          ownerUserId,
          ownerUserId,
          ownerUserId,
          projectId,
          organizationId,
          organizationId,
          ownerUserId,
        )
        .first<ProjectAccessRow>(),
      this.database
        .prepare(WORKSPACE_ACCESS_SQL)
        .bind(
          ownerUserId,
          ownerUserId,
          ownerUserId,
          ownerUserId,
          ownerUserId,
          ownerUserId,
          workspaceId,
          ownerUserId,
        )
        .first<WorkspaceAccessRow>(),
    ])
    if (!user || !membership) throw denied("Agent Plugins organization membership is required")
    if (!project || project.org_id !== organizationId || roleRank(project.role_rank) < 1) {
      throw denied("Agent Plugins project access denied")
    }
    if (!workspace
      || workspace.org_id !== organizationId
      || workspace.project_id !== projectId
      || roleRank(workspace.role_rank) < 1) {
      throw denied("Agent Plugins workspace access denied")
    }
  }

  private async revisionRow(orgId: string) {
    return await this.database
      .prepare(`
        select revision, last_operation_id, last_operation_revision
        from agent_plugin_revisions where org_id = ?
      `)
      .bind(orgId)
      .first<RevisionRow>()
  }

  private async currentRevision(orgId: string) {
    const row = await this.revisionRow(orgId)
    return row ? revisionNumber(row.revision) : 0
  }

  /** Replays an exact retry, otherwise proves the caller's expected revision. */
  private async begin(
    orgId: string,
    expectedRevision: number,
    operation: string,
  ): Promise<{ replay: number } | { revision: number }> {
    const row = await this.revisionRow(orgId)
    if (row && row.last_operation_id === operation && row.last_operation_revision !== null) {
      return { replay: revisionNumber(row.last_operation_revision) }
    }
    const revision = row ? revisionNumber(row.revision) : 0
    if (revision !== expectedRevision) throw conflict(expectedRevision, revision)
    return { revision }
  }

  private async commit(
    orgId: string,
    revision: number,
    operation: string,
    writes: D1PreparedStatement[],
  ) {
    const next = revision + 1
    const guard = assertionId()
    const now = this.now()
    try {
      await this.database.batch([
        ...writes,
        // The compare-and-set is this `where`: a writer that moved the
        // revision between the read above and this batch leaves the row alone.
        this.database
          .prepare(`
            insert into agent_plugin_revisions (org_id, revision, last_operation_id, last_operation_revision, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (org_id) do update set
              revision = excluded.revision,
              last_operation_id = excluded.last_operation_id,
              last_operation_revision = excluded.last_operation_revision,
              updated_at = excluded.updated_at
            where agent_plugin_revisions.revision = ?
          `)
          .bind(orgId, next, operation, next, now, revision),
        // A skipped compare-and-set writes `passed = 0`, whose check constraint
        // aborts every statement in this batch including the writes above. The
        // operation ID is part of the assertion because a concurrent writer
        // reaching the same revision would otherwise look like this one's own
        // update landing.
        this.database
          .prepare(`
            insert into authority_batch_assertions (assertion_id, passed)
            select ?, case when exists (
              select 1 from agent_plugin_revisions
              where org_id = ? and revision = ? and last_operation_id = ?
            ) then 1 else 0 end
          `)
          .bind(guard, orgId, next, operation),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(guard),
      ])
    } catch (cause) {
      if (!assertionFailed(cause)) throw cause
      throw conflict(revision, await this.currentRevision(orgId))
    }
    return next
  }

  private writePin(input: {
    scopeKey: string
    authority: "user" | "organization"
    orgId: string
    ownerUserId: string | null
    pluginInstanceId: string
    artifact: AgentPluginArtifactPin
    now: number
  }) {
    return this.database
      .prepare(`
        insert into agent_plugin_artifact_pins (
          scope_key, plugin_instance_id, authority, org_id, owner_user_id,
          artifact_digest, source_id, relative_path, source_revision, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (scope_key, plugin_instance_id) do update set
          artifact_digest = excluded.artifact_digest,
          source_id = excluded.source_id,
          relative_path = excluded.relative_path,
          source_revision = excluded.source_revision,
          updated_at = excluded.updated_at
      `)
      .bind(
        input.scopeKey,
        input.pluginInstanceId,
        input.authority,
        input.orgId,
        input.ownerUserId,
        input.artifact.digest,
        input.artifact.sourceId,
        input.artifact.relativePath,
        input.artifact.sourceRevision,
        input.now,
      )
  }

  private writeUserDefault(input: {
    scope: Scope
    pluginInstanceId: string
    harnessId: AgentPluginHarnessId
    choice: boolean | undefined
    now: number
  }) {
    if (input.choice === undefined) {
      return this.database
        .prepare(`
          delete from agent_plugin_user_defaults
          where org_id = ? and owner_user_id = ? and plugin_instance_id = ? and harness_id = ?
        `)
        .bind(input.scope.orgId, input.scope.userId, input.pluginInstanceId, input.harnessId)
    }
    return this.database
      .prepare(`
        insert into agent_plugin_user_defaults (
          org_id, owner_user_id, plugin_instance_id, harness_id, enabled, updated_at
        )
        values (?, ?, ?, ?, ?, ?)
        on conflict (org_id, owner_user_id, plugin_instance_id, harness_id) do update set
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .bind(
        input.scope.orgId,
        input.scope.userId,
        input.pluginInstanceId,
        input.harnessId,
        input.choice ? 1 : 0,
        input.now,
      )
  }

  private writeProjectOverride(input: {
    scope: Scope
    projectId: string
    pluginInstanceId: string
    harnessId: AgentPluginHarnessId
    choice: boolean | undefined
    now: number
  }) {
    if (input.choice === undefined) {
      return this.database
        .prepare(`
          delete from agent_plugin_project_overrides
          where org_id = ? and owner_user_id = ? and project_id = ? and plugin_instance_id = ? and harness_id = ?
        `)
        .bind(input.scope.orgId, input.scope.userId, input.projectId, input.pluginInstanceId, input.harnessId)
    }
    return this.database
      .prepare(`
        insert into agent_plugin_project_overrides (
          org_id, owner_user_id, project_id, plugin_instance_id, harness_id, enabled, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict (org_id, owner_user_id, project_id, plugin_instance_id, harness_id) do update set
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .bind(
        input.scope.orgId,
        input.scope.userId,
        input.projectId,
        input.pluginInstanceId,
        input.harnessId,
        input.choice ? 1 : 0,
        input.now,
      )
  }

  private async pinRow(scopeKey: string, pluginInstanceId: string) {
    return await this.database
      .prepare(`select ${PIN_COLUMNS} from agent_plugin_artifact_pins where scope_key = ? and plugin_instance_id = ?`)
      .bind(scopeKey, pluginInstanceId)
      .first<PinRow>()
  }

  private async pinsByOwner(input: {
    orgId: string | null
    authority: "user" | "organization" | "claxedo"
    ownerUserId: string | null
  }) {
    const result = await this.database
      .prepare(`
        select ${PIN_COLUMNS} from agent_plugin_artifact_pins
        where org_id is ? and authority = ? and owner_user_id is ?
        order by plugin_instance_id
      `)
      .bind(input.orgId, input.authority, input.ownerUserId)
      .all<PinRow>()
    const pins = new Map<string, AgentPluginArtifactPin>()
    for (const row of result.results) {
      const pin = artifactPin(row)
      if (pin) pins.set(text(row.plugin_instance_id, "plugin instance ID"), pin)
    }
    return pins
  }

  private async instanceIds(sql: string, binds: readonly string[]) {
    const result = await this.database.prepare(sql).bind(...binds).all<InstanceRow>()
    return result.results.map((row) => text(row.plugin_instance_id, "plugin instance ID"))
  }

  private async knownPlugins(scope: Scope): Promise<SignedKnownPlugin[]> {
    const [
      userPins,
      organizationPins,
      claxedoPins,
      userDefaults,
      projectOverrides,
      organizationDefaults,
      claxedoDefaults,
    ] = await Promise.all([
      this.pinsByOwner({ orgId: scope.orgId, authority: "user", ownerUserId: scope.userId }),
      this.pinsByOwner({ orgId: scope.orgId, authority: "organization", ownerUserId: null }),
      this.pinsByOwner({ orgId: null, authority: "claxedo", ownerUserId: null }),
      this.instanceIds(
        `select distinct plugin_instance_id from agent_plugin_user_defaults where org_id = ? and owner_user_id = ?`,
        [scope.orgId, scope.userId],
      ),
      this.instanceIds(
        `select distinct plugin_instance_id from agent_plugin_project_overrides where org_id = ? and owner_user_id = ?`,
        [scope.orgId, scope.userId],
      ),
      this.instanceIds(
        `select distinct plugin_instance_id from agent_plugin_organization_defaults where org_id = ?`,
        [scope.orgId],
      ),
      this.instanceIds(`select distinct plugin_instance_id from agent_plugin_claxedo_defaults`, []),
    ])
    const ids = new Set<string>([
      ...userPins.keys(),
      ...organizationPins.keys(),
      ...claxedoPins.keys(),
      ...userDefaults,
      ...projectOverrides,
      ...organizationDefaults,
      ...claxedoDefaults,
    ])
    return [...ids].toSorted().map((pluginInstanceId) => {
      const user = userPins.get(pluginInstanceId)
      const organization = organizationPins.get(pluginInstanceId)
      const claxedo = claxedoPins.get(pluginInstanceId)
      return {
        pluginInstanceId,
        pins: {
          ...(user ? { user } : {}),
          ...(organization ? { organization } : {}),
          ...(claxedo ? { claxedo } : {}),
        },
      }
    })
  }

  private async snapshot(
    scope: Scope,
    pluginInstanceId: string,
    harnessId: AgentPluginHarnessId,
    projectId?: string,
  ): Promise<SignedActivationSnapshot> {
    const [
      revision,
      projectOverride,
      userDefault,
      organizationDefault,
      claxedoDefault,
      userPin,
      organizationPin,
      claxedoPin,
    ] = await Promise.all([
      this.currentRevision(scope.orgId),
      projectId
        ? this.database
            .prepare(`
              select enabled from agent_plugin_project_overrides
              where org_id = ? and owner_user_id = ? and project_id = ?
                and plugin_instance_id = ? and harness_id = ?
            `)
            .bind(scope.orgId, scope.userId, projectId, pluginInstanceId, harnessId)
            .first<EnabledRow>()
        : Promise.resolve(null),
      this.database
        .prepare(`
          select enabled from agent_plugin_user_defaults
          where org_id = ? and owner_user_id = ? and plugin_instance_id = ? and harness_id = ?
        `)
        .bind(scope.orgId, scope.userId, pluginInstanceId, harnessId)
        .first<EnabledRow>(),
      this.database
        .prepare(`
          select 1 as present from agent_plugin_organization_defaults
          where org_id = ? and plugin_instance_id = ? and harness_id = ?
        `)
        .bind(scope.orgId, pluginInstanceId, harnessId)
        .first<PresenceRow>(),
      this.database
        .prepare(`
          select 1 as present from agent_plugin_claxedo_defaults
          where plugin_instance_id = ? and harness_id = ?
        `)
        .bind(pluginInstanceId, harnessId)
        .first<PresenceRow>(),
      this.pinRow(userScopeKey(scope.orgId, scope.userId), pluginInstanceId),
      this.pinRow(organizationScopeKey(scope.orgId), pluginInstanceId),
      this.pinRow(CLAXEDO_SCOPE_KEY, pluginInstanceId),
    ])
    const user = artifactPin(userPin)
    const organization = artifactPin(organizationPin)
    const claxedo = artifactPin(claxedoPin)
    return {
      revision,
      pluginInstanceId,
      harnessId,
      ...(projectId ? { projectId } : {}),
      ...(projectOverride ? { projectOverride: enabled(projectOverride.enabled) } : {}),
      ...(userDefault ? { userDefault: enabled(userDefault.enabled) } : {}),
      ...(organizationDefault ? { organizationDefault: true as const } : {}),
      ...(claxedoDefault ? { claxedoDefault: true as const } : {}),
      pins: {
        ...(user ? { user: user.digest } : {}),
        ...(organization ? { organization: organization.digest } : {}),
        ...(claxedo ? { claxedo: claxedo.digest } : {}),
      },
    }
  }

  private async world(
    scope: Scope,
    identity: SignedAgentPluginRuntimeSnapshot["identity"],
    projectId?: string,
  ): Promise<SignedAgentPluginRuntimeSnapshot> {
    const [revision, known] = await Promise.all([this.currentRevision(scope.orgId), this.knownPlugins(scope)])
    const plugins = await Promise.all(known.map(async (entry) => {
      const [opencode, claude, codex, cursor] = await Promise.all([
        this.snapshot(scope, entry.pluginInstanceId, "opencode", projectId),
        this.snapshot(scope, entry.pluginInstanceId, "claude", projectId),
        this.snapshot(scope, entry.pluginInstanceId, "codex", projectId),
        this.snapshot(scope, entry.pluginInstanceId, "cursor", projectId),
      ])
      return {
        pluginInstanceId: entry.pluginInstanceId,
        pins: entry.pins,
        harnesses: { opencode, claude, codex, cursor },
      }
    }))
    return { revision, identity, plugins }
  }
}
