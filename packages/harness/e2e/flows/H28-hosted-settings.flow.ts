import { hostedFetch } from "../harness/hosted-auth"
import { hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"

export async function run() {
  const stack = await startHostedStack("h28-settings")
  try {
    const owner = await hostedOwner(stack)
    await hostedWorkspace(stack, owner, "H28 hosted settings")
    const settings = await hostedFetch(stack, "/api/claxedo/agent-config/mcp", {}, owner)
    if (settings.status === 404) throw new Error("C-2: hosted has no MCP settings route or store")
    if (!settings.ok) throw new Error(`H28 settings read failed: ${settings.status} ${await settings.text()}`)
    throw new Error("H28 MCP settings delivery remains unasserted")
  } finally {
    console.log(`H28 refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
