import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface DockTrayProps extends ComponentProps<"div"> {
  attach?: "none" | "top"
}

export function DockShell(props: ComponentProps<"div">) {
  const split = props,
    rest = omit(props, "children", "class")
  return (
    <div {...rest} data-dock-surface="shell" class={split.class}>
      {split.children}
    </div>
  )
}

export function DockShellForm(props: ComponentProps<"form">) {
  // Keep delegated form submission as an explicit JSX binding. Forwarding it
  // only through a component-level spread leaves Solid without the compile-time
  // event binding it needs, so the browser performs a native submit while the
  // application handler never runs.
  const split = props,
    rest = omit(props, "children", "class", "onSubmit")
  return (
    <form {...rest} onSubmit={split.onSubmit} data-dock-surface="shell" class={split.class}>
      {split.children}
    </form>
  )
}

export function DockTray(props: DockTrayProps) {
  const split = props,
    rest = omit(props, "attach", "children", "class")
  return (
    <div {...rest} data-dock-surface="tray" data-dock-attach={split.attach || "none"} class={split.class}>
      {split.children}
    </div>
  )
}
