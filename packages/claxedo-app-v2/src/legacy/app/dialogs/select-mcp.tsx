import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Component } from "solid-js"
import { marketplaceRoute } from "@/platform/identity/route"
import { useAgentPluginPorts } from "@/app/composition/agent-plugin-ports"
import { McpCatalogDialog } from "@/features/agent-plugins/mcp/catalog-dialog"

/** What the slash-mcp command shows: the catalog dialog over the app's plugin rails. */
export const DialogSelectMcp: Component = () => {
  const ports = useAgentPluginPorts()
  const dialog = useDialog()
  const navigate = useNavigate()
  return (
    <McpCatalogDialog
      mode={ports.mode()}
      api={ports.api()}
      onInstall={ports.openInstall}
      onOpenDirectory={() => {
        dialog.close()
        navigate(marketplaceRoute())
      }}
    />
  )
}
