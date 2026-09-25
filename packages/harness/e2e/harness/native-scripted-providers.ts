import type { ScriptedModelServer } from "./scripted-model-server"
import { sendJson, type HttpTransport } from "./transport"

const NATIVE_PROVIDERS = ["claude-sdk", "codex-app-server"] as const

export async function connectNativeScriptedProviders(transport: HttpTransport, daemonUrl: string, scripted: ScriptedModelServer) {
  for (const providerId of NATIVE_PROVIDERS) {
    await sendJson(transport, "PUT", `${daemonUrl}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`, {
      providerID: providerId,
      name: `Scripted ${providerId}`,
      baseURL: scripted.v1Url,
      env: [],
      headers: {},
      models: { scripted: { name: "Scripted" } },
    }, `Routing ${providerId} through the credential broker to the scripted model`)
    await sendJson(transport, "PUT", `${daemonUrl}/api/claxedo/credentials`, {
      provider_id: providerId,
      kind: "api_key",
      source: "local_only",
      secret: `scripted-${providerId}-key`,
    }, `Storing ${providerId} scripted credential`)
  }
}
