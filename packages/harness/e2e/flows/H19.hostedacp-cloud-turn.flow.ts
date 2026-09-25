import assert from "node:assert/strict"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"

export async function run() {
  const stack = await startHostedStack("h19-hosted-acp")
  try {
    const owner = await hostedOwner(stack)
    await hostedWorkspace(stack, owner, "H19 hosted ACP")
    const connections = await hostedFetch(stack, "/api/claxedo/agent-config/connections", {}, owner)
    assert.equal(connections.status, 200)
    const configuration = await connections.json() as { status?: string; reason?: string }
    if (configuration.status === "unsupported" && configuration.reason === "operator_local_configuration") {
      throw new Error("C-2: hosted has no connection settings to deliver a scripted ACP agent")
    }
    throw new Error(`H19 hosted ACP connection delivery remains unasserted: ${JSON.stringify(configuration)}`)
  } finally {
    console.log(`H19.hostedacp refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
