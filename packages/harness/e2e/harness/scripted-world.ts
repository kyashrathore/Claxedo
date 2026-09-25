import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import type { ScriptedModelServer } from "./scripted-model-server"
import { connectScriptedProviders } from "./scripted-providers"
import { sendJson, type HttpTransport } from "./transport"

const execFileAsync = promisify(execFile)

export type ScriptedWorld = { scripted: ScriptedModelServer; acpScriptDir: string; red: boolean }

async function installScriptedAcp(transport: HttpTransport, url: string, scriptDir: string, red: boolean) {
  const bunPath = (await execFileAsync("which", ["bun"])).stdout.trim()
  if (!bunPath) throw new Error("bun is not on PATH; the scripted ACP agent runs under bun")
  await sendJson(
    transport,
    "PUT",
    `${url}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`,
    scriptedAcpConnection({ bunPath, scriptDir, red }),
    "Scripted ACP connection setup",
  )
}

export async function prepareScriptedServer(transport: HttpTransport, url: string, world: ScriptedWorld) {
  await connectScriptedProviders(transport, url, world.scripted)
  await sendJson(transport, "POST", `${url}/api/claxedo/agent-config/harness`, { harness: { kind: "native", harnessId: "pi" } }, "Pi as the default harness")
  await installScriptedAcp(transport, url, world.acpScriptDir, world.red)
}
