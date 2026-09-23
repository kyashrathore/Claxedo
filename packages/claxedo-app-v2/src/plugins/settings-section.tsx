import { For, Show } from "solid-js"
import type { ShellRegistries } from "@/shell/types"
import type { PluginState, PluginSummary } from "./api"
import type { PluginHost } from "./host"
import { pluginComponents } from "./ui"

let activeHost: PluginHost | undefined

export function registerHostEntries(host: PluginHost, registries: ShellRegistries): void {
  activeHost = host
  registries.settingsSections.add({ id: "plugins", title: () => "Plugins", group: "app", order: 90, view: PluginsSettingsSection })
  registries.commands.add({ id: "plugins.leaveSafeMode", title: () => "Leave safe mode", when: host.safeMode, run: host.leaveSafeMode })
}

function stateLabel(state: PluginState): string {
  switch (state.kind) {
    case "off":
      return "Off"
    case "loading":
      return "Loading"
    case "on":
      return "On"
    case "swapping":
      return "Updating"
    case "failed":
      return "Failed"
  }
}

function stateTone(state: PluginState): "neutral" | "success" | "warning" | "danger" {
  if (state.kind === "on") return state.lastFailure ? "warning" : "success"
  return state.kind === "failed" ? "danger" : "neutral"
}

function PluginRow(props: { readonly plugin: PluginSummary; readonly host: PluginHost }) {
  const { Switch, Button, Badge } = pluginComponents
  const id = () => props.plugin.manifest.id
  const state = () => props.plugin.state
  return (
    <li data-testid={`plugin-row-${id()}`} class="flex flex-col gap-1 border-b py-3">
      <div class="flex items-center gap-2">
        <span class="font-medium">{props.plugin.manifest.name}</span>
        <span class="text-xs">{props.plugin.manifest.version}</span>
        <Badge tone={stateTone(state())}>
          <span data-testid={`plugin-state-${id()}`}>{stateLabel(state())}</span>
        </Badge>
        <span class="flex-1" />
        <Switch
          checked={props.plugin.enabled}
          label={`${props.plugin.manifest.name} on`}
          data-testid={`plugin-switch-${id()}`}
          onChange={(on) => (on ? props.host.switchOn(id()) : props.host.switchOff(id()))}
        />
        <Show when={props.plugin.origin.kind === "live"}>
          <Button variant="danger" size="small" data-testid={`plugin-remove-${id()}`} onClick={() => void props.host.remove(id())}>
            Remove
          </Button>
        </Show>
      </div>
      <Show when={!props.plugin.requirementsMet}>
        <p class="text-xs">Needs: {props.plugin.manifest.requires.join(", ")}</p>
      </Show>
      <Show when={state().kind === "failed" ? state() : undefined}>
        {(failed) => (
          <p role="alert" data-testid={`plugin-failure-${id()}`} class="text-xs">
            {(failed() as Extract<PluginState, { kind: "failed" }>).reason}
          </p>
        )}
      </Show>
      <Show when={state().kind === "on" ? (state() as Extract<PluginState, { kind: "on" }>).lastFailure : undefined}>
        {(failure) => (
          <p role="alert" data-testid={`plugin-swap-failure-${id()}`} class="text-xs">
            Version {failure().version} failed to start: {failure().reason}. Version {(state() as Extract<PluginState, { kind: "on" }>).version} is still on.
          </p>
        )}
      </Show>
    </li>
  )
}

export function PluginsSettingsSection() {
  const host = activeHost
  if (!host) throw new Error("The plugins settings section renders only under a PluginHostProvider")
  const { Button } = pluginComponents
  return (
    <section aria-labelledby="plugins-settings-title" data-testid="plugins-settings" class="flex flex-col gap-3">
      <h2 id="plugins-settings-title" class="text-lg font-medium">
        Plugins
      </h2>
      <Show when={host.safeMode()}>
        <div role="status" data-testid="plugins-safe-mode" class="flex items-center gap-2 rounded-md border p-2 text-sm">
          <span>Safe mode: every user plugin is off for this load.</span>
          <Button size="small" onClick={() => host.leaveSafeMode()}>
            Leave safe mode
          </Button>
        </div>
      </Show>
      <ul class="flex flex-col">
        <For each={host.plugins()}>{(plugin) => <PluginRow plugin={plugin} host={host} />}</For>
      </ul>
    </section>
  )
}
