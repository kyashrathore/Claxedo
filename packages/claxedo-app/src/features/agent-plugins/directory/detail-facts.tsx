import { For, Show } from "solid-js"
import type { PluginCandidate, PluginCatalog } from "../api"
import type { AgentPluginConnectionSummary } from "../connections"
import { CHIP } from "./chrome"
import { activationSummary, connectionFor, installedHarnesses, oauthServers } from "./view"

/**
 * The facts strip: the five answers a user opens the pane for.
 *
 * It sits directly under the header, above the description, because "is this
 * on, and who decided that" is the question the pane exists to answer; the
 * prose is context for an answer the reader already has.
 */
export function PluginFacts(props: {
  plugin: PluginCandidate
  signed: boolean
  catalog: PluginCatalog
  projectId?: string
  connections?: readonly AgentPluginConnectionSummary[]
}) {
  const authentication = () => {
    const servers = oauthServers(props.plugin)
    if (servers.length === 0) return undefined
    if (servers.some((server) => connectionFor(props.connections, server.integrationId, "personal"))) return "Personal"
    if (servers.some((server) => connectionFor(props.connections, server.integrationId, "team"))) return "Enterprise"
    return undefined
  }
  const projects = () => {
    if (!props.signed) return "Every project on this machine"
    if (!props.projectId) return "Cross-project default"
    return props.catalog.projects?.find((project) => project.id === props.projectId)?.label ?? props.projectId
  }
  return (
    <dl
      data-component="agent-plugin-facts"
      class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular"
    >
      <dt class="text-text-weaker">Status</dt>
      <dd class="text-text-base">{activationSummary(props.plugin)}</dd>

      <dt class="text-text-weaker">Where</dt>
      <dd class="flex flex-wrap gap-1.5">
        <span class={CHIP}>Local</span>
        <span class={CHIP}>Cloud</span>
      </dd>

      <dt class="text-text-weaker">Projects</dt>
      <dd class="text-text-base">{projects()}</dd>

      <Show when={installedHarnesses(props.plugin).length > 0}>
        <dt class="text-text-weaker">Harnesses</dt>
        <dd class="flex flex-wrap gap-1.5">
          <For each={installedHarnesses(props.plugin)}>{(harness) => <span class={CHIP}>{harness}</span>}</For>
        </dd>
      </Show>

      <Show when={authentication()}>
        {(mode) => (
          <>
            <dt class="text-text-weaker">Authentication</dt>
            <dd class="text-text-base">{mode()}</dd>
          </>
        )}
      </Show>
    </dl>
  )
}
