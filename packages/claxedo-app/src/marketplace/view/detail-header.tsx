import { Show, type JSX } from "solid-js"
import type { PluginStatus } from "../model"
import { PluginStatusLine } from "./status"

export function DetailHeaderFrame(props: {
  readonly name: string
  readonly icon: JSX.Element
  readonly version?: string
  readonly status?: PluginStatus
  readonly wrapStatus: boolean
  readonly children: JSX.Element
}): JSX.Element {
  return (
    <header class="flex items-start gap-3 border-b border-border-weak-base p-4">
      {props.icon}
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-16-medium text-text-strong">{props.name}</h2>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weaker">
          <Show when={props.version}>{(version) => <span>v{version()}</span>}</Show>
          {props.children}
        </div>
        <Show when={props.status}>
          {(status) => (
            <div class="mt-1.5">
              <PluginStatusLine status={status()} wrap={props.wrapStatus} />
            </div>
          )}
        </Show>
      </div>
    </header>
  )
}
