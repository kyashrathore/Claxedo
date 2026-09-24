import { ErrorBoundary, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@/ui"
import { usePluginsText } from "./i18n"

export function failureReason(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : JSON.stringify(error)
}

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

export function PluginOff(props: { readonly pluginName: string }): JSX.Element {
  const t = usePluginsText()
  return (
    <div role="status" class="plugin-slot-off">
      {t("plugins.off", { name: props.pluginName })}
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
