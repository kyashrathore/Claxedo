import type { ScriptedModelServer } from "./scripted-model-server"

export const SCRIPTED_PROVIDER_IDS = ["anthropic", "openai"] as const

export type ScriptedProviderId = (typeof SCRIPTED_PROVIDER_IDS)[number]

const SCRIPTED_SECRET = "test-key"

function scriptedBaseUrl(providerId: ScriptedProviderId, scripted: ScriptedModelServer) {
  return providerId === "openai" ? scripted.v1Url : scripted.url
}

async function put(url: string, body: unknown, label: string) {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
}

function routeToScripted(daemonUrl: string, providerId: ScriptedProviderId, scripted: ScriptedModelServer) {
  return put(
    `${daemonUrl}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`,
    {
      providerID: providerId,
      name: `Scripted ${providerId}`,
      baseURL: scriptedBaseUrl(providerId, scripted),
      models: { scripted: { name: "Scripted" } },
    },
    `Routing ${providerId} to the scripted model server`,
  )
}

function storeScriptedKey(daemonUrl: string, providerId: ScriptedProviderId) {
  return put(
    `${daemonUrl}/api/claxedo/credentials`,
    { provider_id: providerId, kind: "api_key", source: "local_only", secret: SCRIPTED_SECRET },
    `Storing the scripted ${providerId} key`,
  )
}

export async function connectScriptedProviders(daemonUrl: string, scripted: ScriptedModelServer, input: { red: boolean }) {
  for (const providerId of SCRIPTED_PROVIDER_IDS) {
    if (!input.red) await routeToScripted(daemonUrl, providerId, scripted)
    await storeScriptedKey(daemonUrl, providerId)
  }
}
