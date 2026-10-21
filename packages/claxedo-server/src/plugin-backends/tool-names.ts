import type { D1Database } from "@cloudflare/workers-types"
import { pluginReleaseSchema, type PluginRelease } from "@claxedo/plugin-api/release"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export class AppPluginToolNameTakenError extends ClaxedoError<"app_plugin_tool_name_taken"> {
  constructor(message: string) {
    super({ code: "app_plugin_tool_name_taken", message })
  }
}

/**
 * Refuses a release that declares a tool this deployment's MCP mounts already
 * register themselves, or one another plugin installed in the organization
 * declares: an agent addresses a tool by its name alone, so two owners of one
 * name would leave either the core tool or a plugin's unreachable.
 */
export async function assertToolNamesFree(
  database: D1Database,
  reserved: ReadonlySet<string>,
  orgId: string,
  release: PluginRelease,
): Promise<void> {
  const names = (release.tools ?? []).map((tool) => tool.name)
  if (names.length === 0) return
  const core = names.find((name) => reserved.has(name))
  if (core) throw new AppPluginToolNameTakenError(`${release.id} declares the tool ${core}, which Claxedo itself serves`)
  const { results } = await database
    .prepare("select plugin_id, release_json from app_plugin_installs where org_id = ? and plugin_id <> ?")
    .bind(orgId, release.id)
    .all<{ plugin_id: string; release_json: string }>()
  for (const row of results) {
    const installed = new Set((pluginReleaseSchema.parse(JSON.parse(row.release_json)).tools ?? []).map((tool) => tool.name))
    const taken = names.find((name) => installed.has(name))
    if (taken) throw new AppPluginToolNameTakenError(`${release.id} declares the tool ${taken}, which the installed plugin ${row.plugin_id} serves`)
  }
}
