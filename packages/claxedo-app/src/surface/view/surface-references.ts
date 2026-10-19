import { createContext, useContext, type Component } from "solid-js"
import type { SurfaceAgentConfiguration } from "@claxedo/plugin-api/surface"

export type SurfaceAgentConfigurationPickerProps = {
  readonly placement: "local" | "cloud"
  readonly value: SurfaceAgentConfiguration
  readonly disabled: boolean
  readonly onChange: (value: SurfaceAgentConfiguration) => void
}

export type SurfaceReferences = {
  readonly AgentConfigurationPicker: Component<SurfaceAgentConfigurationPickerProps>
}

const SurfaceReferencesContext = createContext<SurfaceReferences>()

export const SurfaceReferencesProvider = SurfaceReferencesContext.Provider

export function useSurfaceReferences(): SurfaceReferences | undefined {
  return useContext(SurfaceReferencesContext)
}
