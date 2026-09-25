import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { titleAndArchive } from "./H12-title-archive.flow"

export async function run() {
  const stack = await startStack({ label: "h12-acp-archive-running-turn" })
  try {
    await titleAndArchive(stack, new ClaxedoApi(stack.url), "acp")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("acp archived turn outcome was not observed")) {
      throw new Error("H-9: archiving the ACP session left its running turn without a stored outcome", { cause: error })
    }
    throw error
  } finally {
    await stack.close()
  }
}
