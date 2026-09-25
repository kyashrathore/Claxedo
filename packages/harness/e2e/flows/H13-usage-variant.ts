import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { usageTurn } from "./H13-usage.flow"

export async function runNativeUsageVariant(name: "pi" | "claude" | "codex") {
  const stack = await startStack({ label: `h13-${name}-usage` })
  try {
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    try {
      await usageTurn(stack, new ClaxedoApi(stack.url), name)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${name} assistant model usage was not observed`)) {
        assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
        throw new Error(`H-13: ${name} usage reached the scripted model but not the stored assistant message`, { cause: error })
      }
      throw error
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
  } finally {
    await stack.close()
  }
}
