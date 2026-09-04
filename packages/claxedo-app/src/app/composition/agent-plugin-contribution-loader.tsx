import { Show, Suspense } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { AgentPluginContributionSet } from "./product-contributions"
import { AgentPluginDirectory, directoryApi } from "@/features/agent-plugins/directory"
import { InstallAgentPluginSheet } from "@/features/agent-plugins/install/sheet"
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
import { accountDirectoryApi } from "./agent-plugin-account-directory-api"

function DirectorySurface() {
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
  const api = () => mode() === "signed" ? (desktopSigned() ? desktopSignedApi : browserSignedApi) : unsignedApi
  // Sources follow the account, but what other harnesses installed on this
  // machine can only be read by the machine's own sidecar, so that half is
  // always the local rail — in every mode.
  const localDirectory = directoryApi({ baseUrl: getDefaultBaseUrl(), request: unsignedLocalFetch })
  const browserSignedDirectory = directoryApi({ baseUrl, request: platform.fetch ?? authFetch })
  const desktopSignedDirectory = accountDirectoryApi(account, localDirectory.machineInstalled)
  const directory = () => {
    if (mode() !== "signed") return localDirectory
    return desktopSigned() ? desktopSignedDirectory : browserSignedDirectory
  }
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
      <AgentPluginDirectory
        mode={mode()}
        api={api()}
        directory={directory()}
        connections={mode() === "signed" ? connections : undefined}
        onAdd={(plugin, catalog) => new Promise<void>((resolve) => {
          void dialog.show(() => (
            <InstallAgentPluginSheet
              plugin={plugin}
              mode={mode()}
              catalog={{
                revision: catalog.revision,
                projects: catalog.projects,
                supportedHarnesses: catalog.supportedHarnesses,
                canManageOrganizationDefaults: catalog.canManageOrganizationDefaults,
                canManageOrganizationConnections: catalog.canManageOrganizationConnections,
              }}
              api={api()}
              connections={mode() === "signed" ? connections : undefined}
              onDone={() => resolve()}
            />
          ))
        })}
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
      renderer: () => <Suspense fallback={<SurfaceFallback />}><DirectorySurface /></Suspense>,
    }],
  }
}
