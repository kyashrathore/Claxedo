import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { scriptedAcpConnection, unsetAcpConnection } from "../../../harness/e2e/harness/acp/connection"
import type { ScriptedModelServer } from "../../../harness/e2e/harness/scripted-model-server"
import { connectScriptedProviders, storeScriptedKeys, type ScriptedProviderId } from "../../../harness/e2e/harness/scripted-providers"
import { sendJson, type HttpTransport } from "../../../harness/e2e/harness/transport"

const execFileAsync = promisify(execFile)

export const APP_SCRIPTED_PROVIDER_IDS = ["anthropic", "openai"] as const satisfies readonly ScriptedProviderId[]

export type ScriptedWorld = { scripted: ScriptedModelServer; acpScriptDir: string; red: boolean }

async function bunPath() {
  const found = (await execFileAsync("which", ["bun"])).stdout.trim()
  if (!found) throw new Error("bun is not on PATH; the scripted ACP agent runs under bun")
  return found
}

async function installAcpConnection(transport: HttpTransport, url: string, connection: { connectionId: string; config: { label: string } }) {
  await sendJson(transport, "PUT", `${url}/api/claxedo/agent-config/connections/${connection.connectionId}`, connection, `${connection.config.label} connection setup`)
}

export async function installUnsetAcp(transport: HttpTransport, url: string, scriptDir: string) {
  await installAcpConnection(transport, url, unsetAcpConnection({ bunPath: await bunPath(), scriptDir }))
}

export async function prepareScriptedServer(transport: HttpTransport, url: string, world: ScriptedWorld) {
  if (world.red) await storeScriptedKeys(transport, url, APP_SCRIPTED_PROVIDER_IDS)
  else await connectScriptedProviders(transport, url, world.scripted, APP_SCRIPTED_PROVIDER_IDS)
  await sendJson(transport, "POST", `${url}/api/claxedo/agent-config/harness`, { harness: { kind: "native", harnessId: "pi" } }, "Pi as the default harness")
  await installAcpConnection(transport, url, scriptedAcpConnection({ bunPath: await bunPath(), scriptDir: world.acpScriptDir, red: world.red, core: true }))
}
