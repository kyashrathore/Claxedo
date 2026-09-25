import { ErrorBoundary, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@/ui"
import { failureReason } from "./failure"
import { usePluginsText } from "./i18n"
import "./view/plugins.css"

export function PluginBoundary(props: { readonly pluginName: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <ErrorBoundary fallback={(error, reset) => <PluginFailed name={props.pluginName} error={error} reset={reset} />}>
      {props.children}
    </ErrorBoundary>
  )
}

function PluginFailed(props: { readonly name: string; readonly error: unknown; readonly reset: () => void }): JSX.Element {
  const t = usePluginsText()
  return (
    <div role="alert" class="plugin-slot-failure" data-plugin-failure={props.name}>
      <p class="plugin-slot-failure-title">{t("plugins.boundary.failed", { name: props.name })}</p>
      <p class="plugin-slot-failure-reason">{failureReason(props.error)}</p>
      <Button type="button" variant="ghost" size="small" onClick={() => props.reset()}>
        {t("plugins.boundary.retry")}
      </Button>
    </div>
  )
}

export function boundedView<Props extends object>(pluginName: string, view: Component<Props>): Component<Props> {
  return (props: Props) => (
    <PluginBoundary pluginName={pluginName}>
      <Dynamic component={view} {...props} />
    </PluginBoundary>
  )
}
