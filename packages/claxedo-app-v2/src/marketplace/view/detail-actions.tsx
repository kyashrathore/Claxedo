import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginHarness } from "@/server"
import { Button } from "@/ui"
import { dictionary } from "../i18n"
import { defaultOutcome, isBuiltIn, isInstalled, pluginLabel } from "../model"
import { OverflowItem, OverflowMenu } from "./overflow-menu"

type ActionProps = {
  readonly plugin: PluginCandidate
  readonly harnesses: readonly PluginHarness[]
  readonly pending: boolean
  readonly onAdd: () => void
  readonly onActivate: (choice: boolean | null) => void
  readonly onUpdate: () => void
}

function MainAction(props: ActionProps & { readonly acquired: boolean; readonly mutable: boolean }): JSX.Element {
  const t = useTranslator(dictionary)
  const disabled = () => props.pending || !props.mutable
  const busy = (label: string) => (props.pending ? t("marketplace.action.applying") : label)
  return (
    <Show
      when={isInstalled(props.plugin)}
      fallback={
        <Show
          when={props.acquired}
          fallback={
            <Button size="small" variant="primary" disabled={disabled()} onClick={() => props.onAdd()}>
              {t("marketplace.action.add")}
            </Button>
          }
        >
          <Button size="small" variant="primary" disabled={disabled()} onClick={() => props.onActivate(true)}>
            {busy(t("marketplace.action.enable"))}
          </Button>
        </Show>
      }
    >
      <Button size="small" variant="secondary" disabled={disabled()} onClick={() => props.onActivate(false)}>
        {busy(t("marketplace.action.disable"))}
      </Button>
    </Show>
  )
}

export function PluginActions(props: ActionProps): JSX.Element {
  const t = useTranslator(dictionary)
  const builtIn = () => isBuiltIn(props.plugin)
  const acquired = () => builtIn() || Boolean(props.plugin.retainedDigest)
  const mutable = () => props.plugin.sourceAvailable || acquired()
  const outcomeHint = () => {
    const outcome = defaultOutcome({ plugin: props.plugin, harnesses: props.harnesses })
    const state = t(outcome.enabled ? "marketplace.action.wouldEnable" : "marketplace.action.wouldDisable")
    const key =
      outcome.authority === "organization"
        ? "marketplace.action.followOrganization"
        : "marketplace.action.followClaxedo"
    return t(key, { state })
  }
  const version = () => props.plugin.manifest?.version
  return (
    <div class="flex items-center gap-1.5 px-4 py-3">
      <MainAction {...props} acquired={acquired()} mutable={mutable()} />
      <Show when={!builtIn()}>
        <OverflowMenu label={t("marketplace.moreActions", { name: pluginLabel(props.plugin) })}>
          <OverflowItem disabled={props.pending} onSelect={() => props.onActivate(null)} hint={outcomeHint()}>
            {t("marketplace.action.clearOverride")}
          </OverflowItem>
          <Show when={props.plugin.updateAvailable}>
            <OverflowItem disabled={props.pending} onSelect={() => props.onUpdate()}>
              {version()
                ? t("marketplace.action.updateTo", { version: version() ?? "" })
                : t("marketplace.action.updateLatest")}
            </OverflowItem>
          </Show>
        </OverflowMenu>
      </Show>
    </div>
  )
}
