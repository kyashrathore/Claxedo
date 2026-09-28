import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { workspaceRuntimeBootEnv } from "@claxedo/sandbox-manager/runtime-env"
import { daemonRuntime } from "./daemon"
import { startEgressGuard } from "./egress-guard"
import { waitForHealth } from "./health"
import { isolatedEnv } from "./isolated-env"
import { claxedoAgentPluginsWorkspaceRuntimeEntry } from "../../../claxedo-server/src/hosts/workspace-runtime/startup"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { releasePort, reservePort } from "./ports"
import { captureOutput, stopProcess } from "./process"

export async function startCloudProductHost(nativeHarness?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h19-product-host-"))
  const directory = path.join(root, "workspace")
  const storeRoot = path.join(root, "store")
  await fs.mkdir(directory)
  await fs.mkdir(storeRoot)
  const port = await reservePort()
  const guardPort = await reservePort()
  const guard = await startEgressGuard(guardPort)
  const env: NodeJS.ProcessEnv = {
    ...await isolatedEnv(root, guard.url),
    ...workspaceRuntimeBootEnv({ workspaceId: "ws_h19_product", directory, port, nativeHarness }),
    WORKSPACE_RUNTIME_STORE_DIR: storeRoot,
    CLAXEDO_DATA_DIR: path.join(root, "data"),
  }
  if (process.env.CLAXEDO_E2E_CLOUD_FAULT === "startup-key-withheld") delete env.WORKSPACE_RUNTIME_NATIVE_HARNESS
  const runtime = await daemonRuntime()
  const owned = captureOutput(spawn(runtime.node, [
    "--conditions=development", "--import", pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href,
    "--import", TSX_LOADER, claxedoAgentPluginsWorkspaceRuntimeEntry(),
  ], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }))
  const close = async () => {
    await stopProcess(owned.child, { processGroup: true })
    await guard.close()
    releasePort(port)
    releasePort(guardPort)
    if (process.env.CLAXEDO_E2E_KEEP_DATA !== "1") await fs.rm(root, { recursive: true, force: true })
  }
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(`${url}/api/wr/health`, { label: "H19 product host", ...owned, timeoutMs: 60_000 })
  } catch (error) {
    await close()
    throw error
  }
  return { url, directory, storeRoot, guard, log: owned.log, close }
}
