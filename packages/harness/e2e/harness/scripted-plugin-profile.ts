import { inspectPluginTree } from "../../../claxedo-server-core/src/agent-plugins/artifacts/acquire"
import { encodePluginTreeBase64 } from "../../../claxedo-server-core/src/agent-plugins/artifacts/codec"
import { agentPluginTree } from "../../../claxedo-server-core/src/agent-plugins/artifacts/tree"
import { directTransport, sendJson } from "./transport"

export async function applyScriptedPluginProfile(daemonUrl: string, mcpUrl: string, harnessIds: Array<"claude" | "codex">) {
  const encoder = new TextEncoder()
  const file = (path: string, value: unknown) => ({
    path, kind: "file" as const, executableMode: 0,
    bytes: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)),
  })
  const inspected = await inspectPluginTree(agentPluginTree([
    file("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "e2e-proof", version: "1.0.0" }),
    file("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { proof: { type: "streamable-http", url: mcpUrl } } }),
    { path: "skills", kind: "directory" },
    { path: "skills/proof", kind: "directory" },
    file("skills/proof/SKILL.md", "---\nname: proof\ndescription: Calls the configured proof tool\n---\n\nUse the proof tool.\n"),
  ]))
  const response = await sendJson(directTransport, "PUT", `${daemonUrl}/api/claxedo/plugins/signed-runtime`, {
    version: 1,
    identity: { mode: "signed", userId: "e2e-user", projectId: "e2e-project" },
    revision: 1,
    execution: { mode: "default" },
    selections: [{ pluginInstanceId: "e2e/proof", artifactDigest: inspected.digest, harnessIds }],
    artifacts: [{ digest: inspected.digest, tree: encodePluginTreeBase64(inspected.tree) }],
    mcpServers: [],
    secrets: [],
  }, "Apply scripted plugin profile")
  return JSON.parse(response) as { active: boolean; generationId: string }
}
