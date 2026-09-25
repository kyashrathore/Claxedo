import { createSignal, Show, type JSX } from "solid-js"
import { useI18n } from "@/i18n"
import { formatDateTimeMed } from "@/lib/relative-time"
import { unreachable } from "@/lib/machine"
import { useServer } from "@/server"
import { Switch, Tag, Button, useDialog } from "@/ui"
import { approvalLetsRun } from "../approval"
import { failureReason } from "../failure"
import { usePluginsText, type PluginsKey, type PluginsText } from "../i18n"
import { failureOf, type PluginState, type PluginSummary } from "../model"
import { usePluginHost } from "../provider"
import { PluginManifestSummary } from "./plugin-manifest"
import { openPluginSource } from "./source-dialog"

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

function approvalDetail(t: PluginsText, plugin: PluginSummary, locale: string): string | undefined {
  const approval = plugin.approval
  if (approval.kind === "accessChanged") return t("plugins.accessChanged")
  if (approval.kind === "codeChanged") return t("plugins.codeChanged", { time: formatDateTimeMed(Date.parse(approval.builtAt), locale) })
  if (approval.kind === "unapproved" && plugin.switchedOn) return t("plugins.unapproved")
  return undefined
}

function detailOf(t: PluginsText, plugin: PluginSummary, locale: string): string | undefined {
  const failure = failureOf(plugin.state)
  if (failure && plugin.state.kind === "failed") return t("plugins.failure", { reason: failure.reason })
  if (failure) return t("plugins.lastFailure", { reason: failure.reason })
  if (plugin.origin.kind === "live" && plugin.origin.buildError) return t("plugins.lastFailure", { reason: plugin.origin.buildError })
  if (plugin.switchedOn && plugin.missing.length > 0) return t("plugins.missing", { capabilities: plugin.missing.join(", ") })
  return approvalDetail(t, plugin, locale)
}

function RowActions(props: { readonly plugin: PluginSummary; readonly expanded: boolean; readonly toggle: () => void }): JSX.Element {
  const t = usePluginsText()
  const host = usePluginHost()
  const server = useServer()
  const dialog = useDialog()
  const [removeFailure, setRemoveFailure] = createSignal<string>()
  const remove = async () => {
    setRemoveFailure(undefined)
    try {
      await host.remove(props.plugin.id)
    } catch (error) {
      setRemoveFailure(t("plugins.remove.failed", { name: props.plugin.name, reason: failureReason(error) }))
    }
  }
  return (
    <div class="plugin-row-actions">
      <Button type="button" variant="ghost" size="small" aria-expanded={props.expanded} onClick={() => props.toggle()}>
        {t("plugins.details")}
      </Button>
      <Show when={props.plugin.origin.kind === "live"}>
        <Button type="button" variant="ghost" size="small" onClick={() => openPluginSource(dialog, server, { id: props.plugin.id, name: props.plugin.name })}>
          {t("plugins.viewCode")}
        </Button>
        <Button type="button" variant="ghost" size="small" onClick={() => void remove()}>
          {t("plugins.remove")}
        </Button>
      </Show>
      <Show when={removeFailure()}>{(text) => <p role="alert">{text()}</p>}</Show>
    </div>
  )
}

export function PluginRow(props: { readonly plugin: PluginSummary }): JSX.Element {
  const host = usePluginHost()
  const t = usePluginsText()
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const detail = () => detailOf(t, props.plugin, i18n.intlTag())
  const toggle = (on: boolean) => {
    if (!on) return host.switchOff(props.plugin.id)
    if (!approvalLetsRun(props.plugin.approval)) return host.requestApproval(props.plugin.id)
    host.switchOn(props.plugin.id)
  }
  return (
    <li class="plugin-row" data-plugin={props.plugin.id} aria-label={props.plugin.name}>
      <div class="plugin-row-main">
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
        </div>
        <Switch checked={props.plugin.switchedOn && approvalLetsRun(props.plugin.approval)} onChange={toggle} hideLabel>
          {t("plugins.switch", { name: props.plugin.name })}
        </Switch>
      </div>
      <RowActions plugin={props.plugin} expanded={expanded()} toggle={() => setExpanded((open) => !open)} />
      <Show when={expanded()}>
        <PluginManifestSummary plugin={props.plugin} />
      </Show>
    </li>
  )
}
