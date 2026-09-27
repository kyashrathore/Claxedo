import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, splitProps, Switch, type JSX } from "solid-js"
import type { ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { adoptElement } from "./adopt-element"
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
  const [woken, setWoken] = createSignal(false)
  const [state, setState] = createStore({
    open: false,
    block: false,
    expand: false,
  })
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "contentClass",
    "contentStyle",
    "inactive",
    "forceOpen",
    "ignoreSafeArea",
    "value",
  ])

  const close = () => setState("open", false)

  const inside = () => {
    const active = document.activeElement
    if (!ref || !active) return false
    return ref.contains(active)
  }

  const drop = (expand = state.expand) => {
    if (expand) return
    if (ref?.matches(":hover")) return
    if (inside()) return
    setState("block", false)
  }

  const sync = () => {
    const expand = !!ref?.querySelector('[aria-expanded="true"], [data-expanded]')
    setState("expand", expand)
    if (expand) {
      setState("block", true)
      close()
      return
    }
    drop(expand)
  }

  const leave = () => {
    if (!inside()) close()
    drop()
  }

  const live = createMemo((was: boolean) => was || woken() || !!local.forceOpen, false)

  const wake = (event: PointerEvent) => {
    if (live()) return
    setWoken(true)
    // Kobalte's listener is added during this dispatch and misses it; the replay starts its open delay.
    ref?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: event.pointerType }))
  }

  let justClickedTrigger = false

  return (
    <Switch>
      <Match when={local.inactive}>{local.children}</Match>
      <Match when={true}>
        <div
          ref={ref}
          data-component="tooltip-v2-trigger"
          data-closed=""
          class={local.class}
          onPointerEnter={wake}
          onPointerLeave={leave}
          onFocusOut={() => requestAnimationFrame(() => drop())} classList={{ "ui-tooltip-v2-trigger": true }}
        >
          {local.children}
        </div>
        <Show when={live()}>
          {(() => {
            createEffect(() => {
              if (!ref) return
              sync()
              const obs = new MutationObserver(sync)
              obs.observe(ref, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["aria-expanded", "data-expanded"],
              })
              onCleanup(() => obs.disconnect())
            })
            return (
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
                  setState("open", open)
                }}
              >
                <KobalteTooltip.Trigger as={adoptElement(() => ref)} />
                <KobalteTooltip.Portal>
                  <KobalteTooltip.Content
                    ref={(el) => {
                      const theme = ref?.closest("[data-theme]")?.getAttribute("data-theme")
                      if (theme) el.setAttribute("data-theme", theme)
                    }}
                    data-component="tooltip-v2"
                    data-placement={props.placement}
                    data-force-open={local.forceOpen}
                    class={local.contentClass}
                    style={local.contentStyle}
                    onPointerDownOutside={(e) => {
                      if (ref === e.target || (e.target instanceof Node && ref?.contains(e.target))) {
                        justClickedTrigger = true
                      }
                      e.preventDefault()
                    }} classList={{ "ui-tooltip-v2": true }}
                  >
                    {local.value}
                  </KobalteTooltip.Content>
                </KobalteTooltip.Portal>
              </KobalteTooltip>
            )
          })()}
        </Show>
      </Match>
    </Switch>
  )
}
