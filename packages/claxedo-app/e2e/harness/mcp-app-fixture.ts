import { MCP_APP_MIME } from "@claxedo/agent-runtime-contract"
import { applyScriptedPluginProfile, SCRIPTED_PLUGIN_NAME } from "../../../harness/e2e/harness/scripted-plugin-profile"
import { startScriptedMcpServer, type ScriptedMcpTool } from "../../../harness/e2e/harness/scripted-mcp-server"

export const MCP_APP_FIXTURE_SERVER = "fixture"
export const MCP_APP_FIXTURE_URI = "ui://fixture/app"
export const MCP_APP_FIXTURE_FORECAST = "Fixture forecast: sunny"

const SHOW_APP: ScriptedMcpTool = {
  name: "show_app",
  description: "Show the fixture forecast app",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  _meta: { ui: { resourceUri: MCP_APP_FIXTURE_URI } },
  result: () => ({ content: [{ type: "text", text: MCP_APP_FIXTURE_FORECAST }], structuredContent: { sky: "sunny" } }),
}

const RECORD_VISIT: ScriptedMcpTool = {
  name: "record_visit",
  description: "Record that the fixture app was visited",
  inputSchema: { type: "object", properties: { visitor: { type: "string" } }, required: ["visitor"] },
  _meta: { ui: { visibility: ["app"] } },
  result: (args) => ({ content: [{ type: "text", text: `Visit recorded for ${typeof args.visitor === "string" ? args.visitor : "nobody"}` }] }),
}

const APP_DOCUMENT = `<!doctype html>
<html>
<head><title>Fixture app</title></head>
<body class="theme-unset">
<main>
<h1>Fixture app</h1>
<p id="result">Waiting for the tool result</p>
<button id="visit" type="button">Record a visit</button>
<p id="visit-result"></p>
</main>
<script>
let nextId = 1
const pending = new Map()
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*")
})
const notify = (method, params) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*")
const resultText = (result) => (result && Array.isArray(result.content) ? result.content : []).map((block) => block.text || "").join("")
const reportSize = () => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return
  const message = event.data
  if (message.method === undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  } else if (message.method === "ui/notifications/tool-result") {
    document.getElementById("result").textContent = "Tool result: " + resultText(message.params)
    reportSize()
  } else if (message.method === "ui/resource-teardown") {
    window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*")
  }
})
document.getElementById("visit").addEventListener("click", async () => {
  const answer = await request("tools/call", { name: "record_visit", arguments: { visitor: "fixture app" } })
  document.getElementById("visit-result").textContent = answer.error ? "Visit refused: " + answer.error.message : "Visit result: " + resultText(answer.result)
  reportSize()
})
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "fixture-app", version: "1.0.0" }, appCapabilities: {} }).then((answer) => {
  const theme = answer.result && answer.result.hostContext && answer.result.hostContext.theme
  document.body.className = "theme-" + (theme || "unset")
  notify("ui/notifications/initialized", {})
  reportSize()
})
</script>
</body>
</html>
`

export function mcpAppFrameTitle() {
  return new RegExp(`^${SCRIPTED_PLUGIN_NAME}-[0-9a-f]{8}-${MCP_APP_FIXTURE_SERVER} app$`)
}

export async function startMcpAppFixture(daemonUrl: string) {
  const server = await startScriptedMcpServer([SHOW_APP, RECORD_VISIT], [{ uri: MCP_APP_FIXTURE_URI, mimeType: MCP_APP_MIME, text: APP_DOCUMENT }])
  try {
    const applied = await applyScriptedPluginProfile(daemonUrl, { harnessIds: ["pi"], servers: { [MCP_APP_FIXTURE_SERVER]: { type: "streamable-http", url: server.url } } })
    if (!applied.active) throw new Error("The MCP app fixture's plugin profile did not become active")
  } catch (error) {
    await server.close()
    throw error
  }
  return server
}
