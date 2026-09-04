import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate, PluginCatalog } from "../api"
import type { AgentPluginConnectionSummary } from "../connections"
import { GHOST_ICON_BUTTON, HEADING, ROW } from "./chrome"
import { PluginActions } from "./detail-actions"
import { PluginFacts } from "./detail-facts"
import { PluginMcpServers } from "./detail-mcp"
import {
  AGENT_PLUGIN_PANE_MAX_FRACTION,
  AGENT_PLUGIN_PANE_MIN_WIDTH,
  readPaneWidth,
  writePaneWidth,
} from "./pane-width"
import { PluginIconTile } from "./plugin-icon"
import { SkillView } from "./skill-view"
import { PluginStatusLine } from "./status"
import { pluginLabel, pluginStatus } from "./view"

const RESIZE_STEP = 16

/**
 * The Directory's detail pane: everything known about one plugin, and every
 * action that changes it.
 *
 * The activation, update, organization-default and connection calls stay in the
 * Directory (one owner for the catalog revision and the refetch); this
 * component only decides what is shown and when an action is legal.
 *
 * It owns two views. The plugin view answers "what is this and is it on"; a
 * skill row navigates to the skill view, which is the same column showing one
 * SKILL.md as a document. Escape unwinds one level at a time — skill view back
 * to plugin view, plugin view closed — which is why the pane, not the
 * Directory, handles the key while a skill is open.
 */
export function PluginDetailPane(props: {
  plugin: PluginCandidate
  signed: boolean
  catalog: PluginCatalog
  api: AgentPluginApi
  harnesses: readonly AgentPluginHarness[]
  projectId?: string
  connections?: readonly AgentPluginConnectionSummary[]
  connectionsLoading: boolean
  connectionsError?: unknown
  pending: boolean
  onAdd: () => void
  onActivate: (choice: boolean | null) => void
  onUpdate: () => void
  onOrganizationDefault: (choice: true | null) => void
  onConnect: (input: { serverName: string; integrationId: string; scope: "personal" | "team"; issuer?: string }) => void
  onDisconnect: (connection: AgentPluginConnectionSummary) => void
  onClose: () => void
}) {
  const [skill, setSkill] = createSignal<string>()
  const [width, setWidth] = createSignal(readPaneWidth())
  const [surface, setSurface] = createSignal(typeof window === "undefined" ? 1280 : window.innerWidth)

  let pane: HTMLElement | undefined
  const measure = () => setSurface(pane?.parentElement?.clientWidth || window.innerWidth)
  onMount(() => {
    measure()
    window.addEventListener("resize", measure)
    onCleanup(() => window.removeEventListener("resize", measure))
  })

  const maxWidth = () => Math.max(AGENT_PLUGIN_PANE_MIN_WIDTH, Math.round(surface() * AGENT_PLUGIN_PANE_MAX_FRACTION))
  const resize = (next: number) => {
    const clamped = Math.min(maxWidth(), Math.max(AGENT_PLUGIN_PANE_MIN_WIDTH, Math.round(next)))
    setWidth(clamped)
    writePaneWidth(clamped)
  }
  // The shared handle is pointer-driven; its rest props are the seam a keyboard
  // contract hangs off, so the separator's own keys go through them.
  const onHandleKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? RESIZE_STEP : event.key === "ArrowRight" ? -RESIZE_STEP : 0
    if (step !== 0) {
      event.preventDefault()
      event.stopPropagation()
      resize(width() + step)
      return
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      event.stopPropagation()
      resize(event.key === "Home" ? maxWidth() : AGENT_PLUGIN_PANE_MIN_WIDTH)
    }
  }

  const name = () => pluginLabel(props.plugin)
  const status = () => pluginStatus({
    plugin: props.plugin,
    ...(props.connections ? { connections: props.connections } : {}),
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !skill()) return
    event.preventDefault()
    event.stopPropagation()
    setSkill(undefined)
  }

  return (
    <aside
      ref={pane}
      data-component="agent-plugin-detail"
      aria-label={`${name()} details`}
      style={{ width: `${width()}px` }}
      class="relative flex min-h-0 max-w-full shrink-0 flex-col border-l border-border-weak-base bg-surface-base"
      onKeyDown={onKeyDown}
    >
      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={width()}
        min={AGENT_PLUGIN_PANE_MIN_WIDTH}
        max={maxWidth()}
        onResize={resize}
        role="separator"
        tabIndex={0}
        aria-label="Resize plugin details"
        aria-orientation="vertical"
        aria-valuenow={width()}
        aria-valuemin={AGENT_PLUGIN_PANE_MIN_WIDTH}
        aria-valuemax={maxWidth()}
        onKeyDown={onHandleKeyDown}
      />

      <Show
        when={skill()}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <header class="flex items-start gap-3 border-b border-border-weak-base p-4">
              <PluginIconTile icon={props.plugin.icon} name={name()} size="pane" />
              <div class="min-w-0 flex-1">
                <h2 class="truncate text-16-medium text-text-strong">{name()}</h2>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weaker">
                  <Show when={props.plugin.manifest?.version}>{(version) => <span>v{version()}</span>}</Show>
                  <span class="truncate">{props.plugin.source?.label ?? "retained artifact"}</span>
                  <Show when={props.plugin.relativePath}>
                    {(path) => <span class="truncate text-12-mono">{path()}</span>}
                  </Show>
                </div>
                <Show when={status()}>
                  {(value) => <div class="mt-1.5"><PluginStatusLine status={value()} /></div>}
                </Show>
              </div>
              <button
                type="button"
                aria-label="Close details"
                class={`${GHOST_ICON_BUTTON} size-6`}
                onClick={() => props.onClose()}
              >
                ×
              </button>
            </header>

            <PluginFacts
              plugin={props.plugin}
              signed={props.signed}
              catalog={props.catalog}
              projectId={props.projectId}
              connections={props.connections}
            />

            <Show when={props.plugin.manifest?.description}>
              {(description) => <p class="px-4 pt-3 text-13-regular text-text-base">{description()}</p>}
            </Show>
            <Show when={!props.plugin.sourceAvailable}>
              <p class="px-4 pt-2 text-12-regular text-text-weak">Source unavailable; retained bytes remain usable.</p>
            </Show>
            <Show when={props.plugin.artifactError}>
              {(error) => <p class="px-4 pt-2 text-12-regular text-icon-critical-base">{error()}</p>}
            </Show>

            <PluginActions
              plugin={props.plugin}
              signed={props.signed}
              catalog={props.catalog}
              harnesses={props.harnesses}
              pending={props.pending}
              onAdd={props.onAdd}
              onActivate={props.onActivate}
              onUpdate={props.onUpdate}
              onOrganizationDefault={props.onOrganizationDefault}
            />

            <section class="border-t border-border-weak-base px-4 pb-4">
              <h3 class={`${HEADING} pt-3 pb-2`}>Skills <span class="text-text-weaker">{props.plugin.skills.length}</span></h3>
              <Show
                when={props.plugin.skills.length > 0}
                fallback={<p class={`${ROW} text-12-regular text-text-weak`}>This plugin has no skills.</p>}
              >
                <For each={props.plugin.skills}>
                  {(entry) => (
                    <button
                      type="button"
                      data-agent-plugin-skill={entry.name}
                      class={`${ROW} mb-1.5 flex w-full items-center gap-2 text-left hover:bg-surface-raised-strong`}
                      onClick={() => setSkill(entry.name)}
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-12-medium text-text-strong">{entry.name}</span>
                        <span class="block truncate text-11-regular text-text-weaker">{entry.description}</span>
                      </span>
                      <span aria-hidden="true" class="shrink-0 text-text-weaker">›</span>
                    </button>
                  )}
                </For>
              </Show>
            </section>

            <section class="border-t border-border-weak-base px-4 pb-6" aria-label={`${name()} MCP servers`}>
              <h3 class={`${HEADING} pt-3 pb-2`}>
                MCP servers <span class="text-text-weaker">{props.plugin.mcpServers.length}</span>
              </h3>
              <Show
                when={props.plugin.mcpServers.length > 0}
                fallback={<p class={`${ROW} text-12-regular text-text-weak`}>This plugin has no MCP servers.</p>}
              >
                <PluginMcpServers
                  plugin={props.plugin}
                  catalog={props.catalog}
                  connections={props.connections}
                  connectionsLoading={props.connectionsLoading}
                  connectionsError={props.connectionsError}
                  onConnect={props.onConnect}
                  onDisconnect={props.onDisconnect}
                />
              </Show>
            </section>
          </div>
        }
      >
        {(open) => (
          <SkillView
            api={props.api}
            pluginInstanceId={props.plugin.pluginInstanceId}
            pluginName={name()}
            skill={open()}
            projectId={props.projectId}
            onBack={() => setSkill(undefined)}
          />
        )}
      </Show>
    </aside>
  )
}
