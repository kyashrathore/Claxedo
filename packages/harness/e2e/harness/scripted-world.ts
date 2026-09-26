import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import type { ScriptedModelServer } from "./scripted-model-server"
import { connectScriptedProviders } from "./scripted-providers"
import { sendJson, type HttpTransport } from "./transport"

export type ScriptedWorld = { scripted: ScriptedModelServer; acpScriptDir: string; red: boolean; resistantChild?: boolean }

async function installScriptedAcp(transport: HttpTransport, url: string, world: ScriptedWorld) {
  await sendJson(
    transport,
    "PUT",
    `${url}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`,
    scriptedAcpConnection({ bunPath: process.execPath, scriptDir: world.acpScriptDir, red: world.red, resistantChild: world.resistantChild }),
    "Scripted ACP connection setup",
  )
}

export async function prepareScriptedServer(transport: HttpTransport, url: string, world: ScriptedWorld) {
  await connectScriptedProviders(transport, url, world.scripted)
  await sendJson(transport, "POST", `${url}/api/claxedo/agent-config/harness`, { harness: { kind: "native", harnessId: "pi" } }, "Pi as the default harness")
  await installScriptedAcp(transport, url, world)
}
