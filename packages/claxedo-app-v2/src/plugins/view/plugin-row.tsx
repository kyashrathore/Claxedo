import { createSignal, Show, type JSX } from "solid-js"
import { unreachable } from "@/lib/machine"
import { Button, Switch, Tag } from "@/ui"
import { failureReason } from "../failure"
import { usePluginsText, type PluginsKey, type PluginsText } from "../i18n"
import { failureOf, type PluginState, type PluginSummary } from "../model"
import { usePluginHost } from "../provider"

function stateKey(state: PluginState): PluginsKey {
  switch (state.kind) {
    case "off":
      return "plugins.state.off"
    case "loading":
      return "plugins.state.loading"
    case "on":
      return "plugins.state.on"
    case "swapping":
      return "plugins.state.swapping"
    case "failed":
      return "plugins.state.failed"
    default:
      return unreachable(state)
  }
}

function detailOf(t: PluginsText, plugin: PluginSummary): string | undefined {
  const failure = failureOf(plugin.state)
  if (failure && plugin.state.kind === "failed") return t("plugins.failure", { reason: failure.reason })
  if (failure) return t("plugins.lastFailure", { reason: failure.reason })
  if (plugin.origin.kind === "live" && plugin.origin.buildError) return t("plugins.lastFailure", { reason: plugin.origin.buildError })
  if (plugin.switchedOn && plugin.missing.length > 0) return t("plugins.missing", { capabilities: plugin.missing.join(", ") })
  if (plugin.switchedOn && !plugin.confirmed) return t("plugins.unconfirmed")
  return undefined
}

export function PluginRow(props: { readonly plugin: PluginSummary }): JSX.Element {
  const host = usePluginHost()
  const t = usePluginsText()
  const [removeFailure, setRemoveFailure] = createSignal<string>()
  const detail = () => detailOf(t, props.plugin)
  const toggle = (on: boolean) => {
    if (!on) return host.switchOff(props.plugin.id)
    if (!props.plugin.confirmed) return host.requestConfirmation(props.plugin.id)
    host.switchOn(props.plugin.id)
  }
  const remove = async () => {
    setRemoveFailure(undefined)
    try {
      await host.remove(props.plugin.id)
    } catch (error) {
      setRemoveFailure(t("plugins.remove.failed", { name: props.plugin.name, reason: failureReason(error) }))
    }
  }
  return (
    <li class="plugin-row" data-plugin={props.plugin.id} aria-label={props.plugin.name}>
      <div class="plugin-row-text">
        <div class="plugin-row-heading">
          <span class="plugin-row-name">{props.plugin.name}</span>
          <Tag>{t(props.plugin.origin.kind === "live" ? "plugins.origin.live" : "plugins.origin.bundled")}</Tag>
          <span class="plugin-row-version">{props.plugin.version}</span>
          <span class="plugin-row-state" data-state={props.plugin.state.kind}>
            {t(stateKey(props.plugin.state))}
          </span>
        </div>
        <Show when={detail()}>{(text) => <p class="plugin-row-detail">{text()}</p>}</Show>
        <Show when={removeFailure()}>{(text) => <p role="alert">{text()}</p>}</Show>
      </div>
      <Switch checked={props.plugin.switchedOn && props.plugin.confirmed} onChange={toggle} hideLabel>
        {t("plugins.switch", { name: props.plugin.name })}
      </Switch>
      <Show when={props.plugin.origin.kind === "live"}>
        <Button type="button" variant="ghost" size="small" onClick={() => void remove()}>
          {t("plugins.remove")}
        </Button>
      </Show>
    </li>
  )
}
