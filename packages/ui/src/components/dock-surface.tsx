import { type ComponentProps, type JSX, createEffect, createMemo, on, onCleanup, onMount, splitProps } from "solid-js"

export function DockLayout(props: {
  children: JSX.Element
  overlay: JSX.Element
  replace?: boolean
  class?: string
  /** Pixels the overlay reaches above the layout's top edge, the band it covers outside its own box. */
  onOverhang?: (height: number) => void
}) {
  let root!: HTMLDivElement
  let overlay!: HTMLDivElement
  // Read once under this owner: a ResizeObserver callback runs with no owner,
  // and a prop getter evaluated there builds an ownerless memo that is never
  // disposed and keeps the caller's whole tree alive.
  const replace = createMemo(() => !!props.replace)
  const measure = () => props.onOverhang?.(Math.max(0, overlay.offsetHeight - (replace() ? root.offsetHeight : 0)))
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(overlay)
    onCleanup(() => observer.disconnect())
  })
  createEffect(on(replace, measure, { defer: true }))
  return (
    <div ref={root} data-component="dock-layout" data-replace={replace() || undefined} class={props.class}>
      <div ref={overlay} data-slot="dock-layout-overlay">{props.overlay}</div>
      <div data-slot="dock-layout-base" inert={replace()}>{props.children}</div>
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
