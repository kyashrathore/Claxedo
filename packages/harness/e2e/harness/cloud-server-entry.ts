import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLocalBrokeringSandboxDriver } from "@claxedo/sandbox-manager/drivers/local-brokering"
import { startSelfHostedServer } from "../../../claxedo-server/src/deployments/self-hosted-node/start"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { cloudFaultDriver, installCloudConfigFault } from "./cloud-faults"

const port = Number(process.env.CLAXEDO_SERVER_PORT)
const modelUrl = process.env.CLAXEDO_E2E_MODEL_URL
const root = process.env.CLAXEDO_DATA_DIR
if (!Number.isSafeInteger(port) || !modelUrl || !root) throw new Error("cloud test stack needs port, model URL and data directory")
installCloudConfigFault(process.env.CLAXEDO_E2E_CLOUD_FAULT)

const textImports = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
const sandboxDriver = createLocalBrokeringSandboxDriver({
  root,
  executable: process.execPath,
  args: [
    "--conditions=development",
    "--import", textImports,
    "--import", TSX_LOADER,
    path.join(REPO_ROOT, "packages/workspace-runtime/src/cli.ts"),
  ],
  allowedOrigins: [`http://127.0.0.1:${port}`, modelUrl],
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
