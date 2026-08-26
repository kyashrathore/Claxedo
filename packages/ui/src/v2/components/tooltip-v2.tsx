import { storePath } from "solid-js"
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { createEffect, Match, omit, Switch } from "solid-js"
import type { JSX } from "@solidjs/web"
import type { ComponentProps } from "@solidjs/web"
import { createStore } from "solid-js"
import "./tooltip-v2.css"

export interface TooltipV2Props extends ComponentProps<typeof KobalteTooltip> {
  value: JSX.Element
  class?: string
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  inactive?: boolean
  forceOpen?: boolean
}

export function TooltipV2(props: TooltipV2Props) {
  let ref: HTMLDivElement | undefined
  const [state, setState] = createStore({
    open: false,
    block: false,
    expand: false,
  })
  const local = props,
    others = omit(
      props,
      "children",
      "class",
      "contentClass",
      "contentStyle",
      "inactive",
      "forceOpen",
      "ignoreSafeArea",
      "value",
    )

  const close = () => setState(storePath("open", false))

  const inside = () => {
    const active = document.activeElement
    if (!ref || !active) return false
    return ref.contains(active)
  }

  const drop = (expand = state.expand) => {
    if (expand) return
    if (ref?.matches(":hover")) return
    if (inside()) return
    setState(storePath("block", false))
  }

  const sync = () => {
    const expand = !!ref?.querySelector('[aria-expanded="true"], [data-expanded]')
    setState(storePath("expand", expand))
    if (expand) {
      setState(storePath("block", true))
      close()
      return
    }
    drop(expand)
  }

  const arm = () => {
    setState(storePath("block", true))
    close()
  }

  const leave = () => {
    if (!inside()) close()
    drop()
  }

  // Nothing to track: the trigger element is not reactive and `sync` only WRITES
  // the store. A constant compute keeps this the one-shot it has always been —
  // the compute phase runs at creation, before the ref is assigned, so the
  // element read and the observer both belong in the effect phase.
  createEffect(
    () => undefined,
    () => {
      if (!ref) return
      sync()
      const obs = new MutationObserver(sync)
      obs.observe(ref, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-expanded", "data-expanded"],
      })
      return () => obs.disconnect()
    },
  )

  let justClickedTrigger = false

  return (
    <Switch>
      <Match when={local.inactive}>{local.children}</Match>
      <Match when={true}>
        <KobalteTooltip
          gutter={4}
          openDelay={400}
          skipDelayDuration={300}
          {...others}
          closeDelay={0}
          ignoreSafeArea={local.ignoreSafeArea ?? true}
          open={local.forceOpen || state.open}
          onOpenChange={(open) => {
            if (local.forceOpen) return
            if (state.block && open) return
            if (justClickedTrigger) {
              justClickedTrigger = false
              return
            }
            setState(storePath("open", open))
          }}
        >
          <KobalteTooltip.Trigger
            ref={ref}
            as="div"
            data-component="tooltip-v2-trigger"
            onPointerDownCapture={arm}
            onKeyDownCapture={(event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return
              arm()
            }}
            onPointerLeave={leave}
            onFocusOut={() => requestAnimationFrame(() => drop())}
            class={[local.class, "ui-tooltip-v2-trigger"]}
          >
            {local.children}
          </KobalteTooltip.Trigger>
          <KobalteTooltip.Portal>
            <KobalteTooltip.Content
              ref={(el) => {
                const theme = ref?.closest("[data-theme]")?.getAttribute("data-theme")
                if (theme) el.setAttribute("data-theme", theme)
              }}
              data-component="tooltip-v2"
              data-placement={props.placement}
              data-force-open={local.forceOpen}
              class={[local.contentClass, "ui-tooltip-v2"]}
              style={local.contentStyle}
              onPointerDownOutside={(e) => {
                if (ref === e.target || (e.target instanceof Node && ref?.contains(e.target))) {
                  justClickedTrigger = true
                }
                e.preventDefault()
              }}
            >
              {local.value}
            </KobalteTooltip.Content>
          </KobalteTooltip.Portal>
        </KobalteTooltip>
      </Match>
    </Switch>
  )
}
