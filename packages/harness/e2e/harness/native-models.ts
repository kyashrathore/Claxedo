import type { ScriptedModelServer } from "./scripted-model-server"
import { sendJson, type HttpTransport } from "./transport"

const NATIVE_PROVIDERS = [
  { id: "claude-sdk", name: "Scripted Claude Code" },
  { id: "codex-app-server", name: "Scripted Codex" },
] as const

export async function routeNativeModels(transport: HttpTransport, daemonUrl: string, scripted: ScriptedModelServer) {
  for (const provider of NATIVE_PROVIDERS) {
    await sendJson(
      transport,
      "PUT",
      `${daemonUrl}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`,
      {
        providerID: provider.id,
        name: provider.name,
        baseURL: scripted.url,
        models: { scripted: { name: "Scripted" } },
      },
      `Routing ${provider.id} to the scripted model server`,
    )
    await sendJson(
      transport,
      "PUT",
      `${daemonUrl}/api/claxedo/credentials`,
      { provider_id: provider.id, kind: "api_key", source: "local_only", secret: "test-key" },
      `Storing the scripted ${provider.id} key`,
    )
  }
}
