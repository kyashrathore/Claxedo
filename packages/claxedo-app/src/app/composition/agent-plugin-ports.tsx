import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogConnectIntegration } from "@/app/dialogs/connect-integration"
import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl } from "@/platform/api/api"
import { useAccountPort } from "@/platform/account/account-provider"
import { createIntegrationsRequest } from "@/platform/account/integrations-request"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { unsignedLocalFetch } from "@/platform/runtime/transport"
import { agentPluginApi, type AgentPluginApi, type PluginCandidate, type PluginCatalog } from "@/features/agent-plugins/api"
import type { AgentPluginConnectionPort } from "@/features/agent-plugins/connections"
import { directoryApi, type DirectoryApi } from "@/features/agent-plugins/directory/data"
import { InstallAgentPluginSheet } from "@/features/agent-plugins/install/sheet"
import { accountAgentPluginApi } from "./agent-plugin-account-api"
import { agentPluginConnectionPort } from "./agent-plugin-connections"
import { accountDirectoryApi } from "./agent-plugin-account-directory-api"

export type AgentPluginPorts = {
  /** The account has settled; before that no rail can be chosen. */
  ready: () => boolean
  mode: () => "signed" | "unsigned"
  api: () => AgentPluginApi
  directory: () => DirectoryApi
  connections: () => AgentPluginConnectionPort | undefined
  /** Resolves once the install sheet closes, whatever it decided. */
  openInstall: (plugin: PluginCandidate, catalog: PluginCatalog) => Promise<void>
}

/**
 * Every Agent Plugins surface's rails, composed once.
 *
 * Which transport answers a plugin read is a property of the account and the
 * platform, not of the surface asking: the Directory and the composer's MCP
 * dialog both browse the same catalog and both post the same activation, so a
 * second copy of this selection would let one surface install where the other
 * cannot see it. Adding the install sheet here keeps the same rule over the
 * mutation the sheet performs.
 *
 * Imports `directoryApi` from its own module rather than the Directory barrel:
 * the barrel also exports the Directory component, which would pull the whole
 * browse surface into every chunk that only needs a transport.
 */
export function useAgentPluginPorts(): AgentPluginPorts {
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
  // `machineInstalled` is declared as a method on `DirectoryApi`; call it
  // through `localDirectory` instead of detaching it from its own object.
  const desktopSignedDirectory = accountDirectoryApi(account, () => localDirectory.machineInstalled())
  const directory = () => {
    if (mode() !== "signed") return localDirectory
    return desktopSigned() ? desktopSignedDirectory : browserSignedDirectory
  }
  // One integrations request for every mode: it picks the signed desktop's
  // named account operations or the browser's authenticated fetch itself.
  const integrationsRequest = createIntegrationsRequest(baseUrl)
  const connectionPort = agentPluginConnectionPort({
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
  const connections = () => mode() === "signed" ? connectionPort : undefined

  return {
    ready: () => account.state().status !== "pending",
    mode,
    api,
    directory,
    connections,
    openInstall: (plugin, catalog) => new Promise<void>((resolve) => {
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
          connections={connections()}
          onDone={() => resolve()}
        />
      ))
    }),
  }
}
