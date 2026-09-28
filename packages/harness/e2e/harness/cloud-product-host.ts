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
import { nativeProviderAuth, nativeProviderDeliveriesFromRepository, nativeProviderSecrets } from "../../../claxedo-server-core/src/credentials/native-delivery-plan"
import {
  mintSupervisorBackplaneToken, supervisorBackplaneTokenAudience, supervisorBackplaneTokenIssuer,
} from "../../../claxedo-server-core/src/platform/auth/runtime-access-token"
import { createWorkspaceRuntimeClient } from "../../../workspace-runtime/src/client"
import type { RuntimeSnapshot } from "../../../workspace-runtime/src/routes/config"
import { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } from "./hosted-keys"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { releasePort, reservePort } from "./ports"
import { captureOutput, stopProcess } from "./process"

const WORKSPACE_ID = "ws_h19_product"

async function ownerAccountDelivery(owner: string) {
  const now = Date.now()
  return await nativeProviderDeliveriesFromRepository({
    owner,
    machineOwnerUserId: owner,
    selections: {},
    selected: [{ credential: {
      id: `cred_${owner}_openai`, owner, provider_id: "openai", kind: "api_key", source: "managed", status: "available",
      created_at: now, updated_at: now, activated_at: now, revision: 1, incarnation: `cred_${owner}_openai`,
    } }],
    readSecret: async () => `${owner}-openai-key`,
    secretBrokering: "native",
  })
}

export async function startCloudProductHost(nativeHarness?: string, options: { accountOwner?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h19-product-host-"))
  const directory = path.join(root, "workspace")
  const storeRoot = path.join(root, "store")
  await fs.mkdir(directory)
  await fs.mkdir(storeRoot)
  const port = await reservePort()
  const guardPort = await reservePort()
  const guard = await startEgressGuard(guardPort)
  const deliveries = options.accountOwner ? await ownerAccountDelivery(options.accountOwner) : []
  const env: NodeJS.ProcessEnv = {
    ...await isolatedEnv(root, guard.url),
    ...workspaceRuntimeBootEnv({ workspaceId: WORKSPACE_ID, directory, port, nativeHarness }),
    ...Object.fromEntries(nativeProviderSecrets(deliveries).map((secret) => [secret.name, `claxedo-broker:${secret.name}`])),
    WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
    WORKSPACE_RUNTIME_MANAGEMENT_ISSUER: supervisorBackplaneTokenIssuer,
    WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: supervisorBackplaneTokenAudience,
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
  const provisionOwnerAccount = async (config: Pick<RuntimeSnapshot, "defaultHarness">) => {
    if (!options.accountOwner) throw new Error("startCloudProductHost was given no account owner")
    const token = await mintSupervisorBackplaneToken({ workspaceId: WORKSPACE_ID, hostId: WORKSPACE_ID, subject: "workspace-supervisor" },
      { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: HOSTED_SIGNING_PRIVATE_KEY, CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: HOSTED_SIGNING_PUBLIC_KEY })
    await createWorkspaceRuntimeClient({ baseUrl: url }).applyConfig({
      version: 4, commands: [], mcp: {}, connections: [], ...config,
      auth: nativeProviderAuth(deliveries, { owner: options.accountOwner, machineOwnerUserId: options.accountOwner, selections: {} }),
    }, { token: token.supervisorBackplaneToken })
  }
  return { url, directory, storeRoot, guard, log: owned.log, close, provisionOwnerAccount }
}
