import { Show, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { AnyPaneKind, ContentViewProps, OpenedContent, PaneKind } from "./types"

export function paneKindEntry<State>(kind: PaneKind<State>): AnyPaneKind {
  const states = new WeakMap<OpenedContent, { readonly state: State }>()
  const opened = (state: State | undefined): OpenedContent | undefined => {
    if (state === undefined) return undefined
    const content: OpenedContent = {
      state,
      title: () => kind.title(state),
      encode: () => kind.encode(state),
      route: () => kind.toRoute?.(state),
    }
    states.set(content, { state })
    return content
  }
  const view: Component<ContentViewProps> = (props) => (
    <Show when={states.get(props.content)}>
      {(held) => <Dynamic component={kind.view} state={held().state} paneId={props.paneId} active={props.active} />}
    </Show>
  )
  return {
    kind: kind.kind,
    singleton: kind.singleton,
    keepMounted: kind.keepMounted,
    icon: kind.icon,
    view,
    decode: (value) => opened(kind.decode(value)),
    fromRoute: (route) => opened(kind.fromRoute?.(route)),
  }
}
