import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_PROVIDER_IDS } from "./scripted-providers"
import type { Stack } from "./stack"
import { directTransport } from "./transport"

export function ownerPiAgentDir(stack: Pick<Stack, "dataDir">) {
  return path.join(stack.dataDir, ".pi", "agent")
}

export async function forgetStoredAccounts(stack: Pick<Stack, "url">) {
  for (const providerId of SCRIPTED_PROVIDER_IDS) {
    const reply = await directTransport({ method: "DELETE", url: `${stack.url}/api/claxedo/credentials/provider/${providerId}` })
    assert.equal(reply.status, 200, `forgetting the stored ${providerId} account: ${reply.body}`)
    assert.deepEqual(JSON.parse(reply.body), { deleted: 1 }, `the stored ${providerId} account was not forgotten`)
  }
}

export async function writeOwnerPiModels(agentDir: string, modelUrl: string, apiKey: string) {
  await fs.mkdir(agentDir, { recursive: true })
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: modelUrl, apiKey } } }))
}
