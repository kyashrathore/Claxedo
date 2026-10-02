import { type ComponentProps, type JSX, splitProps } from "solid-js"

export function DockLayout(props: {
  children: JSX.Element
  overlay: JSX.Element
  replace?: boolean
  class?: string
}) {
  return (
    <div data-component="dock-layout" data-replace={props.replace || undefined} class={props.class}>
      <div data-slot="dock-layout-overlay">{props.overlay}</div>
      <div data-slot="dock-layout-base" inert={props.replace}>{props.children}</div>
    </div>
  )
}

export interface DockTrayProps extends ComponentProps<"div"> {
  attach?: "none" | "top"
}

export function DockShell(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock-surface="shell"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}

export function DockShellForm(props: ComponentProps<"form">) {
  // Keep delegated form submission as an explicit JSX binding. Forwarding it
  // only through a component-level spread leaves Solid without the compile-time
  // event binding it needs, so the browser performs a native submit while the
  // application handler never runs.
  const [split, rest] = splitProps(props, ["children", "class", "classList", "onSubmit"])
  return (
    <form
      {...rest}
      onSubmit={split.onSubmit}
      data-dock-surface="shell"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </form>
  )
}

export function DockTray(props: DockTrayProps) {
  const [split, rest] = splitProps(props, ["attach", "children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock-surface="tray"
      data-dock-attach={split.attach || "none"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}
