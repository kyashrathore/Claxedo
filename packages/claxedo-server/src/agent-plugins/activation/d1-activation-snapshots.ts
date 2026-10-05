import type { D1Database } from "@cloudflare/workers-types"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import { agentPluginHarnessRecord, type AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { organizationScopeKey, userScopeKey } from "../scope-keys"
import { isArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

const CLAXEDO_SCOPE_KEY = "claxedo"

type HarnessRow = { plugin_instance_id: string; harness_id: string }
type ChoiceRow = HarnessRow & { enabled: number }
type PinDigestRow = { scope_key: string; plugin_instance_id: string; artifact_digest: string }

/** The data a snapshot reads is keyed by user and organization. */
export type Scope = { userId: string; orgId: string }

/**
 * One statement per table whatever the plugin count: a catalog page reads
 * every candidate, retained and built-in plugin on every harness, and D1 runs
 * a Worker's statements a few at a time, so per-pair reads cost seconds.
 * The ids travel as one JSON array so the bound-parameter limit never
 * depends on how many plugins a caller has.
 */
export async function readActivationSnapshots(input: {
database: D1Database
revision: Promise<number>
scope: Scope
pluginInstanceIds: readonly string[]
projectId?: string
}): Promise<Map<string, Record<AgentPluginHarnessId, SignedActivationSnapshot>>> {
const { database, scope, projectId } = input
  const ids = [...new Set(input.pluginInstanceIds)]
  const listed = JSON.stringify(ids)
  const pairs = <Row extends HarnessRow, T>(rows: readonly Row[], value: (row: Row) => T) =>
    new Map(rows.map((row) => [`${row.plugin_instance_id}\n${row.harness_id}`, value(row)]))
  const [revision, overrides, userDefaults, organizationDefaults, claxedoDefaults, pins] = await Promise.all([
    input.revision,
    projectId
      ? database
          .prepare(`
            select plugin_instance_id, harness_id, enabled from agent_plugin_project_overrides
            where org_id = ? and owner_user_id = ? and project_id = ?
              and plugin_instance_id in (select value from json_each(?))
          `)
          .bind(scope.orgId, scope.userId, projectId, listed)
          .all<ChoiceRow>()
          .then((result) => pairs(result.results, (row) => row.enabled === 1))
      : new Map<string, boolean>(),
    database
      .prepare(`
        select plugin_instance_id, harness_id, enabled from agent_plugin_user_defaults
        where org_id = ? and owner_user_id = ? and plugin_instance_id in (select value from json_each(?))
      `)
      .bind(scope.orgId, scope.userId, listed)
      .all<ChoiceRow>()
      .then((result) => pairs(result.results, (row) => row.enabled === 1)),
    database
      .prepare(`
        select plugin_instance_id, harness_id from agent_plugin_organization_defaults
        where org_id = ? and plugin_instance_id in (select value from json_each(?))
      `)
      .bind(scope.orgId, listed)
      .all<HarnessRow>()
      .then((result) => pairs(result.results, () => true as const)),
    database
      .prepare(`
        select plugin_instance_id, harness_id from agent_plugin_claxedo_defaults
        where plugin_instance_id in (select value from json_each(?))
      `)
      .bind(listed)
      .all<HarnessRow>()
      .then((result) => pairs(result.results, () => true as const)),
    database
      .prepare(`
        select scope_key, plugin_instance_id, artifact_digest from agent_plugin_artifact_pins
        where scope_key in (?, ?, ?) and plugin_instance_id in (select value from json_each(?))
      `)
      .bind(userScopeKey(scope.orgId, scope.userId), organizationScopeKey(scope.orgId), CLAXEDO_SCOPE_KEY, listed)
      .all<PinDigestRow>()
      .then((result) => new Map(result.results.map((row) => {
          if (!isArtifactDigest(row.artifact_digest)) throw new Error("D1 returned an invalid Agent Plugins artifact digest")
          return [`${row.scope_key}\n${row.plugin_instance_id}`, row.artifact_digest]
        }))),
  ])
  const pin = (scopeKey: string, pluginInstanceId: string) => pins.get(`${scopeKey}\n${pluginInstanceId}`)
  return new Map(ids.map((pluginInstanceId) => [pluginInstanceId, agentPluginHarnessRecord((harnessId): SignedActivationSnapshot => {
    const pair = `${pluginInstanceId}\n${harnessId}`
    const projectOverride = overrides.get(pair)
    const userDefault = userDefaults.get(pair)
    const user = pin(userScopeKey(scope.orgId, scope.userId), pluginInstanceId)
    const organization = pin(organizationScopeKey(scope.orgId), pluginInstanceId)
    const claxedo = pin(CLAXEDO_SCOPE_KEY, pluginInstanceId)
    return {
      revision,
      pluginInstanceId,
      harnessId,
      ...(projectId ? { projectId } : {}),
      ...(projectOverride === undefined ? {} : { projectOverride }),
      ...(userDefault === undefined ? {} : { userDefault }),
      ...(organizationDefaults.has(pair) ? { organizationDefault: true as const } : {}),
      ...(claxedoDefaults.has(pair) ? { claxedoDefault: true as const } : {}),
      pins: {
        ...(user ? { user } : {}),
        ...(organization ? { organization } : {}),
        ...(claxedo ? { claxedo } : {}),
      },
    }
  })]))
}
