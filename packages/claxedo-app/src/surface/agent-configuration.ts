import { surfaceAgentConfigurationSchema, type SurfaceAgentConfiguration } from "@claxedo/plugin-api/surface"

const UNCHOSEN: SurfaceAgentConfiguration = { harness: null, model: null, effort: null }

export function boundAgentConfiguration(value: unknown): SurfaceAgentConfiguration {
  const parsed = surfaceAgentConfigurationSchema.safeParse(value)
  return parsed.success ? parsed.data : UNCHOSEN
}

export function boundAgentPlacement(value: unknown): "local" | "cloud" {
  return value === "cloud" ? "cloud" : "local"
}
