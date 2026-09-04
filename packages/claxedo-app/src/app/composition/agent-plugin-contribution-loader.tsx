import { Show, Suspense } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { AgentPluginContributionSet } from "./product-contributions"
import { AgentPluginCatalog } from "@/features/agent-plugins/catalog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogConnectIntegration } from "@/app/dialogs/connect-integration"
import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl } from "@/platform/api/api"
import { useAccountPort } from "@/platform/account/account-provider"
import { createIntegrationsRequest } from "@/platform/account/integrations-request"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { unsignedLocalFetch } from "@/platform/runtime/transport"
import { agentPluginApi } from "@/features/agent-plugins/api"
import { accountAgentPluginApi } from "./agent-plugin-account-api"
import { agentPluginConnectionPort } from "./agent-plugin-connections"

function CatalogSurface() {
  const dialog = useDialog()
  const account = useAccountPort()
  const platform = usePlatform()
  const baseUrl = getClaxedoServerUrl()
  // A signed-capable desktop build carries the hosted control-plane URL even
  // while the account is unsigned. Its local plugin authority still lives in
  // the sidecar bound during ServerGate startup; getDefaultBaseUrl() names that
  // canonical runtime binding before considering release environment URLs.
  const unsignedApi = agentPluginApi({ baseUrl: getDefaultBaseUrl(), request: unsignedLocalFetch })
  const browserSignedApi = agentPluginApi({ baseUrl, request: platform.fetch ?? authFetch })
  const desktopSignedApi = accountAgentPluginApi(account)
  const mode = () => account.state().status === "signed" ? "signed" as const : "unsigned" as const
  const desktopSigned = () => platform.platform === "desktop" && mode() === "signed"
  // One integrations request for every mode: it picks the signed desktop's
  // named account operations or the browser's authenticated fetch itself.
  const integrationsRequest = createIntegrationsRequest(baseUrl)
  const connections = agentPluginConnectionPort({
    request: integrationsRequest,
    open(input) {
      void dialog.show(() => (
        <DialogConnectIntegration
          integration={{ id: input.integrationId, name: input.name, methods: ["oauth"], capabilities: ["mcp"] }}
          request={integrationsRequest}
          {...(input.issuer ? { oauthFields: { issuer: input.issuer } } : {})}
          onConnected={() => input.onConnected()}
          personalScopeEnabled
          teamScopeEnabled={input.teamScopeEnabled}
          initialScope={input.scope}
          openUrl={(url) => platform.openLink(url)}
        />
      ))
    },
  })
  return (
    <Show when={account.state().status !== "pending"} fallback={<SurfaceFallback />}>
      <AgentPluginCatalog
        mode={mode()}
        api={mode() === "signed" ? (desktopSigned() ? desktopSignedApi : browserSignedApi) : unsignedApi}
        connections={mode() === "signed" ? connections : undefined}
      />
    </Show>
  )
}

/** Build-composed Agent Plugins UI. This module is the optional chunk boundary. */
export function agentPluginContributions(): AgentPluginContributionSet {
  return {
    contentSurfaces: [{
      id: "surface.content.agent-plugins",
      tier: "claxedo-first-party",
      surface: "marketplace",
      slot: "workbench",
      renderer: () => <Suspense fallback={<SurfaceFallback />}><CatalogSurface /></Suspense>,
    }],
  }
}
