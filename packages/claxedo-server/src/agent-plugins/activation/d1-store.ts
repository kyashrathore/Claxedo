import { isBuiltinPluginInstanceId } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  AgentPluginActivationStoreError,
  type AgentPluginArtifactPin,
  type MutateSignedOrganizationDefault,
  type MutateSignedUserActivation,
  type SignedActivationSnapshot,
  type SignedActivationSnapshots,
  type SignedAgentPluginActivationStore,
  type SignedKnownPlugin,
  type UpdateSignedArtifactPin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import {
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { isArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { asOrgId, asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import type { SignedAgentPluginRuntimeSnapshot } from "../runtime/provision"
import { assertionId, batchUnder, may, maySql, type BoundSql } from "../../authority/adapters/d1/authorization"
import { d1BatchAssertionFailed } from "../../platform/db/d1-constraint"
import { agentPluginWriteGuard, resolveAgentPluginScope, type AgentPluginScope } from "../signed-scope"
import { readActivationSnapshots, type Scope } from "./d1-activation-snapshots"
import { writePin, writeProjectOverride, writeUserDefault } from "./d1-activation-writes"
import { organizationScopeKey, userScopeKey } from "../scope-keys"

/** The project scope a user default addresses; never a real project ID. */
export const AGENT_PLUGIN_ALL_PROJECTS_SCOPE = "all-projects"

/** The workspace a signed desktop pull materializes into; never a real workspace ID. */
export const AGENT_PLUGIN_DESKTOP_WORKSPACE = "desktop"

/**
 * The authority capabilities this store consumes. Signed methods resolve the
 * canonical user and organization through these; no caller-supplied owner or
 * organization ID ever reaches a statement below.
 */
export type AgentPluginActivationAuthority = Pick<
  WorkspaceAuthority,
  "usersMe" | "resolveOrgId" | "authorizeProject"
>

export type D1SignedAgentPluginActivationStoreInput = {
  database: D1Database
  authority: AgentPluginActivationAuthority
  now?: () => number
}

type RequestResolution = {
  scope?: Promise<AgentPluginScope>
  /** Keyed `${action}:${projectId}`; a settled entry is an authorization that passed. */
  projects: Map<string, Promise<void>>
}


type PinRow = {
  plugin_instance_id: string
  artifact_digest: string
  source_id: string
  relative_path: string
  source_revision: string
}

type RevisionRow = {
  revision: number
  last_operation_id: string | null
  last_operation_revision: number | null
}

type InstanceRow = {
  plugin_instance_id: string
}

type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: string
}

const PIN_COLUMNS = "plugin_instance_id, artifact_digest, source_id, relative_path, source_revision"

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

/**
 * The built-in comes from no source, so there is no tree to retain and no pin
 * to point at. The rule the pin enforces — never enable bytes this deployment
 * does not hold — is already true of it: the bytes are the product.
 */
function requiresRetainedArtifact(pluginInstanceId: string) {
  return !isBuiltinPluginInstanceId(pluginInstanceId)
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
  /**
   * One request = one `SignedControlPlaneAuth` object (`routeAuth` builds it
   * from the bearer), and a catalog read calls this store a dozen times with
   * it. The caller's scope and project authorization are decided by that
   * request's identity, so they resolve once per auth object instead of
   * paying the authority's cross-region round trips on every method call.
   */
  private readonly resolved = new WeakMap<SignedControlPlaneAuth, RequestResolution>()

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
    input: { pluginInstanceIds: readonly string[]; projectId?: string },
  ): Promise<SignedActivationSnapshots> {
    const scope = await this.scope(auth)
    if (input.projectId) await this.requireProject(auth, scope, input.projectId, "read")
    return await this.snapshots(scope, input.pluginInstanceIds, input.projectId)
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
    if (input.choice === true
      && requiresRetainedArtifact(input.pluginInstanceId)
      && !input.artifact
      && !(await this.pinRow(scopeKey, input.pluginInstanceId))) {
      throw artifactUnavailable()
    }
    const now = this.now()
    const writes: D1PreparedStatement[] = []
    if (input.artifact) {
      writes.push(writePin(this.database, {
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
        writes.push(writeUserDefault(this.database, { scope, pluginInstanceId: input.pluginInstanceId, harnessId, choice: input.choice, now }))
        continue
      }
      for (const projectId of projectIds) {
        writes.push(writeProjectOverride(this.database, {
          scope,
          projectId,
          pluginInstanceId: input.pluginInstanceId,
          harnessId,
          choice: input.choice,
          now,
        }))
      }
    }
    return await this.commit(agentPluginWriteGuard(scope, "user", projectIds), scope.orgId, started.revision, operation, writes)
  }

  async mutateOrganizationDefault(auth: SignedControlPlaneAuth, input: MutateSignedOrganizationDefault) {
    const harnessIds = requireHarnesses(input.harnessIds)
    const scope = await this.scope(auth)
    await this.requireOrganizationAdmin(auth)
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
    if (input.choice === true
      && requiresRetainedArtifact(input.pluginInstanceId)
      && !input.artifact
      && !(await this.pinRow(scopeKey, input.pluginInstanceId))) {
      throw artifactUnavailable()
    }
    const now = this.now()
    const writes: D1PreparedStatement[] = []
    if (input.artifact) {
      writes.push(writePin(this.database, {
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
    return await this.commit(agentPluginWriteGuard(scope, "organization"), scope.orgId, started.revision, operation, writes)
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
    // The signed desktop's own world: no project or workspace row can stand
    // for a user's machine, so the scope is the two sentinels the self pull
    // minted with, and access is the user's org membership — the same check
    // that authorized the pull. Everything else is a real cloud workspace.
    const desktop = input.projectId === AGENT_PLUGIN_ALL_PROJECTS_SCOPE
      && input.workspaceId === AGENT_PLUGIN_DESKTOP_WORKSPACE
    if (desktop) await this.requireMembership(input.ownerUserId, input.organizationId)
    else await this.requireRuntimeAccess(input)
    return await this.snapshot(
      { userId: input.ownerUserId, orgId: input.organizationId },
      input.pluginInstanceId,
      harnessId,
      desktop ? undefined : input.projectId,
    )
  }

  private async requireMembership(ownerUserId: string, organizationId: string) {
    if (!(await may(this.database, { userId: ownerUserId }, "member", { kind: "org", orgId: organizationId }))) {
      throw denied("Agent Plugins organization membership is required")
    }
  }

  /** The whole desired world of one cloud workspace, from its canonical owner. */
  async runtimeSnapshot(workspaceId: string): Promise<SignedAgentPluginRuntimeSnapshot> {
    const workspace = await this.database
      .prepare(`
        select workspace_id, org_id, project_id, owner_user_id, backing
        from workspaces where workspace_id = ? and deleted_at is null
      `)
      .bind(workspaceId)
      .first<WorkspaceRow>()
    if (!workspace || workspace.backing !== "cloud-vm") {
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
    if (authority === "organization") await this.requireOrganizationAdmin(auth)
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
    return await this.commit(agentPluginWriteGuard(scope, authority), scope.orgId, started.revision, operation, [
      writePin(this.database, {
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

  private resolution(auth: SignedControlPlaneAuth): RequestResolution {
    const existing = this.resolved.get(auth)
    if (existing) return existing
    const created: RequestResolution = { projects: new Map() }
    this.resolved.set(auth, created)
    return created
  }

  private scope(auth: SignedControlPlaneAuth): Promise<AgentPluginScope> {
    const resolution = this.resolution(auth)
    if (!resolution.scope) {
      resolution.scope = resolveAgentPluginScope(this.authority, auth).catch((cause: unknown) => {
        // A failed lookup is not an answer; the next call asks the authority again.
        resolution.scope = undefined
        throw cause
      })
    }
    return resolution.scope
  }

  private requireProject(
    auth: SignedControlPlaneAuth,
    scope: Scope,
    projectId: string,
    action: "read" | "write",
  ): Promise<void> {
    const resolution = this.resolution(auth)
    const key = `${action}:${projectId}`
    const existing = resolution.projects.get(key)
    if (existing) return existing
    const pending = this.authorizeProjectAccess(auth, scope, projectId, action).catch((cause: unknown) => {
      resolution.projects.delete(key)
      throw cause
    })
    resolution.projects.set(key, pending)
    return pending
  }

  private async authorizeProjectAccess(
    auth: SignedControlPlaneAuth,
    scope: Scope,
    projectId: string,
    action: "read" | "write",
  ) {
    // The authority port brands its organization and project IDs; these two
    // came from that same authority, so the brand is restored rather than
    // invented.
    const result = await this.authority.authorizeProject(auth, {
      orgId: asOrgId(scope.orgId),
      projectId: asProjectId(projectId),
      action,
    })
    if (!result.ok) throw denied("Agent Plugins project access denied")
  }

  async administersOrganization(auth: SignedControlPlaneAuth) {
    const scope = await this.scope(auth)
    return await may(this.database, scope, "administer", { kind: "org", orgId: scope.orgId })
  }

  private async requireOrganizationAdmin(auth: SignedControlPlaneAuth) {
    if (!(await this.administersOrganization(auth))) throw denied("Agent Plugins organization admin access required")
  }

  private async requireRuntimeAccess(input: {
    ownerUserId: string
    organizationId: string
    projectId: string
    workspaceId: string
  }) {
    const operates = maySql({ userId: input.ownerUserId }, "operate", { kind: "workspace", alias: "w" })
    const workspace = await this.database
      .prepare(`select 1 from workspaces w where w.workspace_id = ? and w.org_id = ? and w.project_id = ? and ${operates.sql}`)
      .bind(input.workspaceId, input.organizationId, input.projectId, ...operates.bind)
      .first()
    if (!workspace) throw denied("Agent Plugins workspace access denied")
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
    guard: BoundSql,
    orgId: string,
    revision: number,
    operation: string,
    writes: D1PreparedStatement[],
  ) {
    const next = revision + 1
    const revisionAssertion = assertionId()
    const now = this.now()
    try {
      await batchUnder(this.database, guard, [
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
          .bind(revisionAssertion, orgId, next, operation),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(revisionAssertion),
      ])
    } catch (cause) {
      if (!d1BatchAssertionFailed(cause)) throw cause
      throw conflict(revision, await this.currentRevision(orgId))
    }
    return next
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

  private snapshots(scope: Scope, pluginInstanceIds: readonly string[], projectId?: string) {
    return readActivationSnapshots({ database: this.database, revision: this.currentRevision(scope.orgId), scope, pluginInstanceIds, ...(projectId ? { projectId } : {}) })
  }

  private async snapshot(
    scope: Scope,
    pluginInstanceId: string,
    harnessId: AgentPluginHarnessId,
    projectId?: string,
  ): Promise<SignedActivationSnapshot> {
    const rows = await this.snapshots(scope, [pluginInstanceId], projectId)
    const row = rows.get(pluginInstanceId)?.[harnessId]
    if (!row) invalid("activation snapshot")
    return row
  }

  private async world(
    scope: Scope,
    identity: SignedAgentPluginRuntimeSnapshot["identity"],
    projectId?: string,
  ): Promise<SignedAgentPluginRuntimeSnapshot> {
    const [revision, known] = await Promise.all([this.currentRevision(scope.orgId), this.knownPlugins(scope)])
    const rows = await this.snapshots(scope, known.map((entry) => entry.pluginInstanceId), projectId)
    const plugins = known.map((entry) => {
      const harnesses = rows.get(entry.pluginInstanceId)
      if (!harnesses) invalid("activation snapshot")
      return { pluginInstanceId: entry.pluginInstanceId, pins: entry.pins, harnesses }
    })
    return { revision, identity, plugins }
  }
}
