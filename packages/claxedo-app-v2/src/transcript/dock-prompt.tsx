import { Show, type JSX } from "solid-js"
import { DockShell, DockTray } from "@/ui"

export function DockPrompt(props: {
  kind: "question" | "permission"
  header: JSX.Element
  children: JSX.Element
  footer: JSX.Element
  collapsed?: boolean
  ref?: (el: HTMLDivElement) => void
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
}) {
  const slot = (name: "body" | "header" | "content" | "footer") => `${props.kind}-${name}` as const

  return (
    <div
      class="ui-dock-prompt"
      data-kind={props.kind}
      data-collapsed={props.collapsed ? "true" : undefined}
      ref={props.ref}
      onKeyDown={props.onKeyDown}
    >
      <DockShell data-slot={slot("body")}>
        <div data-slot={slot("header")}>{props.header}</div>
        <Show when={!props.collapsed}>
          <div data-slot={slot("content")}>{props.children}</div>
        </Show>
      </DockShell>
      <Show when={!props.collapsed}>
        <DockTray data-slot={slot("footer")}>{props.footer}</DockTray>
      </Show>
    </div>
  )
}
