import { ErrorBoundary, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

export function failureReason(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : JSON.stringify(error)
}

export function PluginBoundary(props: { readonly pluginName: string; readonly children: JSX.Element }) {
  return (
    <ErrorBoundary fallback={(error, reset) => <PluginFailed name={props.pluginName} error={error} reset={reset} />}>
      {props.children}
    </ErrorBoundary>
  )
}

function PluginFailed(props: { readonly name: string; readonly error: unknown; readonly reset: () => void }) {
  return (
    <div role="alert" data-testid="plugin-error" class="flex flex-col gap-2 p-4 text-sm">
      <p class="font-medium">{props.name} failed</p>
      <p data-testid="plugin-error-reason">{failureReason(props.error)}</p>
      <button type="button" class="self-start underline" onClick={() => props.reset()}>
        Try again
      </button>
    </div>
  )
}

export function PluginOff(props: { readonly pluginName: string }) {
  return (
    <div role="status" data-testid="plugin-off" class="p-4 text-sm">
      {props.pluginName} is off. Turn it on in Settings → Plugins.
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
