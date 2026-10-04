/**
 * Capability ports: what a capability name means, and what an integration must
 * provide to claim it.
 *
 * `IntegrationCapability` is derived from this map rather than written as a
 * union, so adding a capability means adding a port — there is no way to name
 * one that nothing serves. The registry derives every declaration's capability
 * set from the ports its impl provides, which is why `IntegrationDeclaration`
 * carries no `capabilities` field for an author to write.
 */
import type { ChannelPort } from "./channel.js"
import type { CodeHostPort } from "./code-host.js"
import type { DocsPort } from "./docs.js"
import type { McpPort } from "./mcp.js"
import type { WorkSourcePort } from "./work-source.js"

export type { BrokeredPort, TokenPort } from "./serving.js"
export type { ChannelPort } from "./channel.js"
export type { CodeHostPort } from "./code-host.js"
export type { DocsPort } from "./docs.js"
export type { McpPort } from "./mcp.js"
export type { WorkSourcePort } from "./work-source.js"
export { channelPort } from "./channel.js"
export { docsPort } from "./docs.js"
export { mcpPort } from "./mcp.js"
export { workSourcePort } from "./work-source.js"

export type CapabilityPorts = {
  "code-host": CodeHostPort
  docs: DocsPort
  "work-source": WorkSourcePort
  channel: ChannelPort
  mcp: McpPort
}

export type IntegrationCapability = keyof CapabilityPorts

/**
 * The runtime enumeration, in the order derived capability sets are reported.
 * A capability added to `CapabilityPorts` and not to this list makes
 * `UnlistedCapability` something other than `never`, and the assertion below
 * stops compiling.
 */
export const CAPABILITIES = ["code-host", "docs", "work-source", "channel", "mcp"] as const satisfies
  readonly IntegrationCapability[]

type UnlistedCapability = Exclude<IntegrationCapability, (typeof CAPABILITIES)[number]>
export const CAPABILITIES_ARE_EXHAUSTIVE: [UnlistedCapability] extends [never] ? true : never = true

/**
 * The capability set an impl actually serves: the keys of its port map, in
 * `CAPABILITIES` order so two registrations of the same ports derive the same
 * array.
 *
 * Every entry is re-checked against the key it was filed under. The types
 * already forbid `{ docs: workSourcePort }`, but a host may register from
 * JavaScript or from a value it parsed, and this set becomes the frozen grant
 * on every connection made to the integration — so a mislabelled port is
 * refused rather than recorded.
 */
export function capabilitiesOf(actions: Partial<CapabilityPorts>): IntegrationCapability[] {
  const served: IntegrationCapability[] = []
  for (const capability of CAPABILITIES) {
    const port: { capability?: unknown } | undefined = actions[capability]
    if (port === undefined) continue
    if (port.capability !== capability) {
      throw new Error(`integration port filed under ${capability} declares ${String(port.capability)}`)
    }
    served.push(capability)
  }
  return served
}
