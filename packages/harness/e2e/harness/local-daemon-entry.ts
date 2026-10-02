import { startLocalServer } from "../../../claxedo-local-server/src/app/start-local-server"
import { createLocalAgentPluginsComposition } from "../../../claxedo-local-server/src/agent-plugins/local-composition"
import { createLocalTasksComposition } from "../../../claxedo-local-server/src/tasks/local-composition"
import { localBuiltinToolGroupsReader } from "../../../claxedo-local-server/src/agent-plugins/builtin-groups"
import { BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"

const port = Number(process.env.CLAXEDO_SERVER_PORT)
if (!Number.isSafeInteger(port) || port <= 0 || !process.env.CLAXEDO_DATA_DIR) {
  throw new Error("The e2e daemon requires a port and an isolated data directory")
}
const plugins = createLocalAgentPluginsComposition()
await plugins.ready
const groups = localBuiltinToolGroupsReader()
const tasks = createLocalTasksComposition({ enabled: () => groups().includes(BUILTIN_TASKS_TOOL_GROUP) })
const server = startLocalServer({
  port,
  routeContributions: [...plugins.routeContributions, ...tasks.routeContributions],
  tasksGrants: tasks.grants,
  pluginRuntime: plugins.runtimeContribution,
})
const distDir = process.env.CLAXEDO_APP_DIST_DIR
if (distDir) {
  const { withAppBundle } = await import("./local-app-bundle")
  const fetch = server.app.fetch.bind(server.app)
  server.app.fetch = withAppBundle(fetch, distDir)
}
await server.ready
console.log(`[claxedo-local-server] listening on http://127.0.0.1:${port}`)
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  const result = await server.stop()
  process.exit(result.ok ? 0 : 75)
}
process.once("SIGTERM", () => { void stop() })
process.once("SIGINT", () => { void stop() })
