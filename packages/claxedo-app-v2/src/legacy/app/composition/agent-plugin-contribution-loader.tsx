import { Show, Suspense } from "solid-js"
import { SurfaceFallback } from "@/app/integrations/surface-fallback"
import type { AgentPluginContributionSet } from "./product-contributions"
import { AgentPluginDirectory } from "@/features/agent-plugins/directory"
import { useAgentPluginPorts } from "./agent-plugin-ports"

function DirectorySurface() {
  const ports = useAgentPluginPorts()
  return (
    <Show when={ports.ready()} fallback={<SurfaceFallback />}>
      <AgentPluginDirectory
        mode={ports.mode()}
        api={ports.api()}
        directory={ports.directory()}
        connections={ports.connections()}
        onAdd={ports.openInstall}
      />
    </Show>
  )
}

/** Build-composed Agent Plugins UI. This module is the lazy chunk boundary. */
export function agentPluginContributions(): AgentPluginContributionSet {
  return {
    contentSurfaces: [{
      id: "surface.content.agent-plugins",
      tier: "claxedo-first-party",
      surface: "marketplace",
      slot: "workbench",
      draggablePane: false,
      renderer: () => <Suspense fallback={<SurfaceFallback />}><DirectorySurface /></Suspense>,
    }],
  }
}
