import { isDeepStrictEqual } from "node:util"
import { pluginProjectionFor } from "@claxedo/session-core"
import type { PluginProjection } from "@claxedo/harness/contract"

/** Keeps a harness's launch generation until its own executable inputs change. */
export function createRuntimeProjection() {
  const projections = new Map<string, { inputs: Omit<PluginProjection, "notApplied">; generation: string }>()
  return (harness: Parameters<typeof pluginProjectionFor>[0], source: Parameters<typeof pluginProjectionFor>[1]): PluginProjection => {
    const projection = pluginProjectionFor(harness, { ...source, generation: "" })
    const { notApplied: _notApplied, ...inputs } = projection
    const key = harness.access === "connection" ? "acp" : harness.id
    const previous = projections.get(key)
    const generation = previous && isDeepStrictEqual(previous.inputs, inputs)
      ? previous.generation : `${source.generation}${projection.generation}`
    projections.set(key, { inputs, generation })
    return { ...projection, generation }
  }
}
