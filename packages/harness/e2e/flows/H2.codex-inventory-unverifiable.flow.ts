import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { stopCase } from "./H2-stop.flow"

export async function run() {
  const stack = await startStack({ label: "h2-codex-inventory", codexInventoryFault: true })
  try {
    await stopCase(stack, new ClaxedoApi(stack.url), {
      name: "codex",
      harness: { id: "codex", access: "native" },
      model: { providerId: "codex", modelId: "gpt-5.5" },
      state: "needs_action",
      stored: "cancelled",
      command: true,
      cleanup: "owned",
    })
    const evidence = await fs.readFile(path.join(stack.dataDir, "codex-inventory-fault-bin", "seen.log"), "utf8")
    assert.equal((evidence.match(/^inventory$/gm) ?? []).length, 2, "Codex did not read inventory before and after termination")
    assert.match(evidence, /"processId"/)
    assert.match(evidence, /"data":\[\]/)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "H2 Codex inventory fault attempted outbound egress")
  } finally {
    await stack.close()
  }
}
