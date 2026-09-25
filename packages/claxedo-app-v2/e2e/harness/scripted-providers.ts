import type { ScriptedModelServer } from "./scripted-model-server"
import { sendJson, type HttpTransport } from "./transport"

export const SCRIPTED_PROVIDER_IDS = ["anthropic", "openai"] as const

export type ScriptedProviderId = (typeof SCRIPTED_PROVIDER_IDS)[number]

const SCRIPTED_SECRET = "test-key"

function scriptedBaseUrl(providerId: ScriptedProviderId, scripted: ScriptedModelServer) {
  return providerId === "openai" ? scripted.v1Url : scripted.url
}

function routeToScripted(transport: HttpTransport, daemonUrl: string, providerId: ScriptedProviderId, scripted: ScriptedModelServer) {
  return sendJson(
    transport,
    "PUT",
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

function storeScriptedKey(transport: HttpTransport, daemonUrl: string, providerId: ScriptedProviderId) {
  return sendJson(
    transport,
    "PUT",
    `${daemonUrl}/api/claxedo/credentials`,
    { provider_id: providerId, kind: "api_key", source: "local_only", secret: SCRIPTED_SECRET },
    `Storing the scripted ${providerId} key`,
  )
}

export async function storeScriptedKeys(transport: HttpTransport, daemonUrl: string) {
  for (const providerId of SCRIPTED_PROVIDER_IDS) await storeScriptedKey(transport, daemonUrl, providerId)
}

export async function connectScriptedProviders(
  transport: HttpTransport,
  daemonUrl: string,
  scripted: ScriptedModelServer,
  input: { red: boolean },
) {
  if (!input.red) for (const providerId of SCRIPTED_PROVIDER_IDS) await routeToScripted(transport, daemonUrl, providerId, scripted)
  await storeScriptedKeys(transport, daemonUrl)
}
