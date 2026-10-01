import fs from "node:fs/promises"
import path from "node:path"
import { scriptedAcpConnection, SCRIPTED_ACP_CONNECTION_ID } from "./acp/connection"
import { writeAcpScript, type AcpScript } from "./acp/script"
import { hostedOwner, hostedControlTransport, type HostedStack } from "./hosted-flow"
import { startHostedStack } from "./hosted-stack"
import { sendJson } from "./transport"

export async function startHostedCloudStack(label: string) {
  const stack = await startHostedStack(label)
  try {
    const owner = await hostedOwner(stack)
    const control = hostedControlTransport(stack, owner)
    const scriptDir = path.join(stack.root, "acp-scripts")
    await sendJson(control, "PUT", `${stack.workerUrl}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`,
      scriptedAcpConnection({ bunPath: process.execPath, scriptDir, red: false }), "Hosted scripted ACP setup")
    await sendJson(control, "POST", `${stack.workerUrl}/api/claxedo/agent-config/harness`,
      { harness: { kind: "native", harnessId: "pi" } }, "Hosted default harness")
    return {
      ...stack, owner, control,
      acp: { scriptDir, write: (name: string, script: AcpScript) => writeAcpScript(scriptDir, name, script) },
    }
  } catch (error) {
    await stack.close()
    throw error
  }
}

export async function hostedRuntimeTarget(stack: HostedStack, workspaceId: string) {
  return JSON.parse(await fs.readFile(path.join(stack.root, "local-broker-targets", `${workspaceId}.json`), "utf8")) as {
    url: string; directory: string; home: string; pid: number; secretNames: string[]
  }
}
