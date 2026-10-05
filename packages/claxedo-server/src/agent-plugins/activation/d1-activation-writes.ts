import type { D1Database } from "@cloudflare/workers-types"
import type { AgentPluginArtifactPin } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { Scope } from "./d1-activation-snapshots"

export function writePin(database: D1Database, input: {
  scopeKey: string
  authority: "user" | "organization"
  orgId: string
  ownerUserId: string | null
  pluginInstanceId: string
  artifact: AgentPluginArtifactPin
  now: number
}) {
  return database
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

export function writeUserDefault(database: D1Database, input: {
  scope: Scope
  pluginInstanceId: string
  harnessId: AgentPluginHarnessId
  choice: boolean | undefined
  now: number
}) {
  if (input.choice === undefined) {
    return database
      .prepare(`
        delete from agent_plugin_user_defaults
        where org_id = ? and owner_user_id = ? and plugin_instance_id = ? and harness_id = ?
      `)
      .bind(input.scope.orgId, input.scope.userId, input.pluginInstanceId, input.harnessId)
  }
  return database
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

export function writeProjectOverride(database: D1Database, input: {
  scope: Scope
  projectId: string
  pluginInstanceId: string
  harnessId: AgentPluginHarnessId
  choice: boolean | undefined
  now: number
}) {
  if (input.choice === undefined) {
    return database
      .prepare(`
        delete from agent_plugin_project_overrides
        where org_id = ? and owner_user_id = ? and project_id = ? and plugin_instance_id = ? and harness_id = ?
      `)
      .bind(input.scope.orgId, input.scope.userId, input.projectId, input.pluginInstanceId, input.harnessId)
  }
  return database
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
