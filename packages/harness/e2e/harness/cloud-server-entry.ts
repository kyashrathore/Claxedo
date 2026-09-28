import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLocalBrokeringSandboxDriver } from "@claxedo/sandbox-manager/drivers/local-brokering"
import { startSelfHostedServer } from "../../../claxedo-server/src/deployments/self-hosted-node/start"
import { claxedoAgentPluginsWorkspaceRuntimeEntry } from "../../../claxedo-server/src/hosts/workspace-runtime/startup"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { cloudFaultDriver, installCloudConfigFault } from "./cloud-faults"

const port = Number(process.env.CLAXEDO_SERVER_PORT)
const modelUrl = process.env.CLAXEDO_E2E_MODEL_URL
const root = process.env.CLAXEDO_DATA_DIR
if (!Number.isSafeInteger(port) || !modelUrl || !root) throw new Error("cloud test stack needs port, model URL and data directory")
installCloudConfigFault(process.env.CLAXEDO_E2E_CLOUD_FAULT)

const mcpUrl = process.env.CLAXEDO_E2E_MCP_URL
const mcpOrigins = mcpUrl ? [new URL(mcpUrl).origin] : []
const textImports = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
const sandboxDriver = createLocalBrokeringSandboxDriver({
  root,
  executable: process.execPath,
  args: [
    "--conditions=development",
    "--import", textImports,
    "--import", TSX_LOADER,
    claxedoAgentPluginsWorkspaceRuntimeEntry(),
  ],
  allowedOrigins: [`http://127.0.0.1:${port}`, modelUrl, ...mcpOrigins],
  upstreams: { "https://api.openai.com": modelUrl },
  directOrigins: [`http://127.0.0.1:${port}`, ...mcpOrigins,
    ...(process.env.CLAXEDO_WORKSPACE_RELAY_URL ? [process.env.CLAXEDO_WORKSPACE_RELAY_URL] : [])],
  inheritedEnv: {
    PATH: process.env.PATH ?? "",
    ...(process.env.PI_EXECUTABLE ? { PI_EXECUTABLE: process.env.PI_EXECUTABLE } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.CI ? { CI: process.env.CI } : {}),
  },
})

void startSelfHostedServer({ port, sandboxDriver: cloudFaultDriver(sandboxDriver, process.env.CLAXEDO_E2E_CLOUD_FAULT) }).then(() => {
  console.log(`[claxedo-server] listening on http://127.0.0.1:${port}`)
})
