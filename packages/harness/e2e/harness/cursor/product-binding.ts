import { directTransport, sendJson } from "../transport"
import type { Stack } from "../stack"

const PROVIDER_ID = "cursor-sdk"

export async function storeCursorAccount(stack: Stack) {
  const response = await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/credentials`, {
    provider_id: PROVIDER_ID,
    kind: "api_key",
    source: "local_only",
    secret: "cursor-placeholder",
  }, "Store the machine owner's scripted Cursor credential")
  const id = (JSON.parse(response) as { credential: { id: string } }).credential.id
  await sendJson(directTransport, "POST", `${stack.url}/api/claxedo/credentials/activate`, { ids: [id] }, "Activate the machine owner's Cursor credential")
}

export async function routeCursorAccount(stack: Stack, backendIndex: number) {
  const backend = stack.cursor[backendIndex]
  if (!backend) throw new Error(`No scripted Cursor backend at index ${backendIndex}`)
  await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`, {
    providerID: PROVIDER_ID,
    name: "Scripted Cursor",
    baseURL: backend.url,
    models: { scripted: { name: "Scripted" } },
  }, "Route the selected Cursor account through the product's provider configuration")
}
