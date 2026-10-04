import { createEffect, createMemo, For, on, Show, type JSX } from "solid-js"
import { usePickDelivery } from "../pick-to-composer"
import { useBrowserTabs } from "../store"
import type { BrowserTab } from "../tab"
import { ConsoleDrawer } from "./console"
import { PageHost } from "./page-host"
import { PickerShield } from "./picker"
import { Toolbar } from "./toolbar"
import { useNoticeToasts } from "./toolbar-actions"

export type BrowserTabViewProps = {
  readonly url?: string
  readonly navigationVersion?: number
  readonly active: boolean
  readonly open: boolean
}

export function BrowserTabView(props: BrowserTabViewProps): JSX.Element {
  const tabs = useBrowserTabs()
  const tab = createMemo(() => {
    const placementId = tabs.placementId()
    return placementId && props.open ? tabs.tabFor(placementId) : undefined
  })
  createEffect(() => {
    const placementId = tabs.placementId()
    if (placementId && !props.open) tabs.closeTab(placementId)
  })
  createEffect(
    on(
      () => [tab(), props.url, props.navigationVersion] as const,
      ([current, url, version]) => {
        if (current && url && version !== undefined) current.navigateOnce(url, version)
      },
    ),
  )
  return (
    <For each={tabs.tabs()}>
      {(current) => <BrowserPage tab={current} active={props.active && tab() === current} />}
    </For>
  )
}

function BrowserPage(props: { readonly tab: BrowserTab; readonly active: boolean }): JSX.Element {
  const deliver = usePickDelivery()
  useNoticeToasts(() => (props.active ? props.tab : undefined))
  return (
    <div
      class="absolute inset-0 flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-base"
      classList={{ hidden: !props.active }}
      inert={!props.active}
      data-testid="workspace-browser-panel"
    >
      <div class="flex h-full w-full flex-col bg-background-base text-text-base">
        <Show when={props.active}>
          <Toolbar tab={props.tab} />
        </Show>
        <div class="relative flex-1">
          <div data-testid="browser-pane-webview-host" class="absolute inset-0">
            <PageHost tab={props.tab} active={props.active} deliver={(pick) => props.active && deliver(pick)} />
            <Show when={props.active}>
              <PickerShield tab={props.tab} />
            </Show>
          </div>
        </div>
        <Show when={props.active}>
          <ConsoleDrawer tab={props.tab} />
        </Show>
      </div>
    </div>
  )
}
