import { PLUGIN_HARNESSES, type PluginCandidate, type PluginHarness, type PluginMcpCloudReach } from "@/server"

export type PluginCloudReach =
  | { readonly kind: "every" }
  | { readonly kind: "only"; readonly harnesses: readonly PluginHarness[] }
  | { readonly kind: "limited" }

function onlyHarnesses(reach: PluginMcpCloudReach): readonly PluginHarness[] | undefined {
  return "onlyHarnesses" in reach ? reach.onlyHarnesses : undefined
}

export function pluginCloudReach(plugin: PluginCandidate): PluginCloudReach {
  const reaches = plugin.mcpServers.flatMap((server) => (server.cloud ? [server.cloud] : []))
  if (reaches.some((reach) => reach.state === "unavailable")) return { kind: "limited" }
  const restrictions = reaches.flatMap((reach) => {
    const harnesses = onlyHarnesses(reach)
    return harnesses ? [harnesses] : []
  })
  if (restrictions.length === 0) return { kind: "every" }
  const harnesses = PLUGIN_HARNESSES.filter((harness) => restrictions.every((allowed) => allowed.includes(harness)))
  return harnesses.length > 0 ? { kind: "only", harnesses } : { kind: "limited" }
}

export function serverCloudLimit(
  reach: PluginMcpCloudReach | undefined,
): { readonly kind: "only"; readonly harnesses: readonly PluginHarness[] } | { readonly kind: "unavailable"; readonly reason: string } | undefined {
  if (!reach) return undefined
  if (reach.state === "unavailable") return { kind: "unavailable", reason: reach.reason }
  const harnesses = onlyHarnesses(reach)
  return harnesses ? { kind: "only", harnesses } : undefined
}
