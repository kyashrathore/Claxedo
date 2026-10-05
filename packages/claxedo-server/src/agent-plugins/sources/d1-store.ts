import type { D1Database } from "@cloudflare/workers-types"
import {
  agentPluginSourceKind,
  type AgentPluginSourceAuthority,
  type AgentPluginSourceRecord,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import {
  AgentPluginSourceRegistryError,
  type AgentPluginSourceRegistry,
} from "@claxedo/server-core/agent-plugins/sources/routes"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { batchUnder, may } from "../../authority/adapters/d1/authorization"
import { d1ConstraintFailure } from "../../platform/db/d1-constraint"
import {
  agentPluginWriteGuard,
  resolveAgentPluginScope,
  type AgentPluginScope as Scope,
  type AgentPluginScopeAuthority,
} from "../signed-scope"
import { organizationScopeKey, userScopeKey } from "../scope-keys"

type SourceRow = {
  id: string
  authority: string
  owner: string
  repository: string
  ref: string
  added_at: number
}

const COLUMNS = "id, authority, owner, repository, ref, added_at"

function invalid(detail: string): never {
  throw new Error(`D1 returned an invalid Agent Plugins source ${detail}`)
}

function text(value: unknown, detail: string) {
  if (typeof value !== "string" || !value) invalid(detail)
  return value
}

function sourceAuthority(value: unknown): AgentPluginSourceAuthority {
  if (value !== "user" && value !== "organization") invalid("authority")
  return value
}

function scopeKey(orgId: string, authority: AgentPluginSourceAuthority, userId: string) {
  return authority === "organization" ? organizationScopeKey(orgId) : userScopeKey(orgId, userId)
}

function toRecord(row: SourceRow): AgentPluginSourceRecord {
  const authority = sourceAuthority(row.authority)
  const owner = text(row.owner, "owner")
  const repository = text(row.repository, "repository")
  return {
    id: text(row.id, "id"),
    kind: agentPluginSourceKind(authority),
    label: `${owner}/${repository}`,
    owner,
    repository,
    ref: text(row.ref, "ref"),
    authority,
    addedAt: typeof row.added_at === "number" ? row.added_at : invalid("timestamp"),
  }
}

/**
 * Durable Agent Plugin source registry over the control-plane database.
 *
 * Visibility is the whole point of the row shape: a personal source is read by
 * the one user who added it inside their organization, and an organization
 * source by every member. Reads are ordered organization-first so the catalog
 * composition, which drops a duplicate provider id, keeps the organization row
 * when a user happens to have registered the same repository personally.
 */
export class D1AgentPluginSourceStore implements AgentPluginSourceRegistry<SignedControlPlaneAuth> {
  private readonly database: D1Database
  private readonly authority: AgentPluginScopeAuthority

  constructor(input: { database: D1Database; authority: AgentPluginScopeAuthority }) {
    this.database = input.database
    this.authority = input.authority
  }

  async list(auth: SignedControlPlaneAuth): Promise<readonly AgentPluginSourceRecord[]> {
    const scope = await this.scope(auth)
    const result = await this.database
      .prepare(`
        select ${COLUMNS} from agent_plugin_sources
        where org_id = ? and (authority = 'organization' or owner_user_id = ?)
        order by case authority when 'organization' then 0 else 1 end, added_at, id
      `)
      .bind(scope.orgId, scope.userId)
      .all<SourceRow>()
    return (result.results ?? []).map(toRecord)
  }

  async canRemove(auth: SignedControlPlaneAuth, source: AgentPluginSourceRecord) {
    if (source.authority === "user") return true
    return await this.organizationAdmin(await this.scope(auth))
  }

  async add(auth: SignedControlPlaneAuth, source: AgentPluginSourceRecord) {
    const scope = await this.scope(auth)
    if (source.authority === "organization") await this.requireOrganizationAdmin(scope)
    const visible = await this.visible(scope, source.id)
    if (visible) {
      throw new AgentPluginSourceRegistryError(
        "source-exists",
        `Source ${source.id} is already registered for this ${visible.authority === "organization" ? "organization" : "user"}`,
      )
    }
    try {
      await batchUnder(this.database, agentPluginWriteGuard(scope, source.authority), [this.database
        .prepare(`
          insert into agent_plugin_sources (
            scope_key, id, org_id, owner_user_id, authority, owner, repository, ref, added_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          scopeKey(scope.orgId, source.authority, scope.userId),
          source.id,
          scope.orgId,
          source.authority === "organization" ? null : scope.userId,
          source.authority,
          source.owner,
          source.repository,
          source.ref,
          source.addedAt,
        )])
    } catch (cause) {
      // The unique primary key is the race-safe half of the duplicate rule: the
      // read above answers a nicer message, this answers a concurrent writer.
      if (d1ConstraintFailure(cause)?.kind === "unique") {
        throw new AgentPluginSourceRegistryError("source-exists", `Source ${source.id} is already registered`)
      }
      throw cause
    }
  }

  async remove(auth: SignedControlPlaneAuth, id: string) {
    const scope = await this.scope(auth)
    const visible = await this.visible(scope, id)
    if (!visible) throw new AgentPluginSourceRegistryError("source-unknown", `Source ${id} is not registered`)
    if (visible.authority === "organization") await this.requireOrganizationAdmin(scope)
    await batchUnder(this.database, agentPluginWriteGuard(scope, visible.authority), [this.database
      .prepare("delete from agent_plugin_sources where scope_key = ? and id = ?")
      .bind(scopeKey(scope.orgId, visible.authority, scope.userId), id)])
  }

  /**
   * The one row this caller acts on for an id: their own personal row when
   * they have one, otherwise the organization row. Both can exist when another
   * member registered the same repository personally.
   */
  private async visible(scope: Scope, id: string) {
    const row = await this.database
      .prepare(`
        select ${COLUMNS} from agent_plugin_sources
        where org_id = ? and id = ? and (authority = 'organization' or owner_user_id = ?)
        order by case authority when 'user' then 0 else 1 end
        limit 1
      `)
      .bind(scope.orgId, id, scope.userId)
      .first<SourceRow>()
    return row ? toRecord(row) : undefined
  }

  private async scope(auth: SignedControlPlaneAuth): Promise<Scope> {
    return await resolveAgentPluginScope(this.authority, auth)
  }

  private async organizationAdmin(scope: Scope) {
    return await may(this.database, scope, "administer", { kind: "org", orgId: scope.orgId })
  }

  private async requireOrganizationAdmin(scope: Scope) {
    if (await this.organizationAdmin(scope)) return
    throw new AgentPluginSourceRegistryError(
      "source-forbidden",
      "Agent Plugins organization sources require the organization admin or owner role",
    )
  }
}
