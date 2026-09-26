import { inspectPluginTree } from "../../../claxedo-server-core/src/agent-plugins/artifacts/acquire"
import { encodePluginTreeBase64 } from "../../../claxedo-server-core/src/agent-plugins/artifacts/codec"
import { agentPluginTree } from "../../../claxedo-server-core/src/agent-plugins/artifacts/tree"
import { directTransport, sendJson } from "./transport"

export type ScriptedPluginHarness = "claude" | "codex" | "acp"

export type ScriptedPluginServer =
  | { type: "streamable-http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[] }

export const SCRIPTED_PLUGIN_INSTANCE_ID = "e2e/proof"
export const SCRIPTED_PLUGIN_NAME = "e2e-proof"

/**
 * The name a plugin server takes in a harness with one flat MCP namespace:
 * `<plugin>-<instance key>-<server>`, as the product projects it.
 */
export function scriptedPluginServerName(serverName: string) {
  return new RegExp(`^${SCRIPTED_PLUGIN_NAME}-[0-9a-f]{8}-${serverName}$`)
}

/**
 * Installs the e2e proof plugin through the product's own plugin path: the
 * signed runtime the desktop pulls from the control plane and hands to the
 * daemon. `revision` advances on every re-install so a change is a change.
 */
export async function applyScriptedPluginProfile(
  daemonUrl: string,
  input: {
    harnessIds: ScriptedPluginHarness[]
    servers: Record<string, ScriptedPluginServer>
    revision?: number
  },
) {
  const encoder = new TextEncoder()
  const file = (path: string, value: unknown) => ({
    path, kind: "file" as const, executableMode: 0,
    bytes: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)),
  })
  const inspected = await inspectPluginTree(agentPluginTree([
    file("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: SCRIPTED_PLUGIN_NAME, version: "1.0.0" }),
    file("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: input.servers }),
    { path: "skills", kind: "directory" },
    { path: "skills/proof", kind: "directory" },
    file("skills/proof/SKILL.md", "---\nname: proof\ndescription: Calls the configured proof tool\n---\n\nUse the proof tool.\n"),
  ]))
  const response = await sendJson(directTransport, "PUT", `${daemonUrl}/api/claxedo/plugins/signed-runtime`, {
    version: 1,
    identity: { mode: "signed", userId: "e2e-user", projectId: "e2e-project" },
    revision: input.revision ?? 1,
    execution: { mode: "default" },
    selections: [{ pluginInstanceId: SCRIPTED_PLUGIN_INSTANCE_ID, artifactDigest: inspected.digest, harnessIds: input.harnessIds }],
    artifacts: [{ digest: inspected.digest, tree: encodePluginTreeBase64(inspected.tree) }],
    mcpServers: [],
    secrets: [],
  }, "Apply scripted plugin profile")
  return JSON.parse(response) as { active: boolean; generationId: string }
}
