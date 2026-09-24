import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { Match, splitProps, Switch, type ComponentProps, type JSX } from "solid-js"
import { createTooltipGuard } from "./tooltip-guard"
import "./tooltip.css"

export interface TooltipProps extends ComponentProps<typeof KobalteTooltip> {
  value: JSX.Element
  class?: string
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  inactive?: boolean
  forceOpen?: boolean
}

export function Tooltip(props: TooltipProps) {
  let trigger: HTMLDivElement | undefined
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
  const guard = createTooltipGuard(() => trigger)

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
          open={local.forceOpen || guard.open()}
          onOpenChange={(open) => {
            if (!local.forceOpen) guard.change(open)
          }}
        >
          <KobalteTooltip.Trigger
            ref={trigger}
            as="div"
            data-component="tooltip-trigger"
            class={local.class}
            classList={{ "ui-tooltip-trigger": true }}
            onPointerDownCapture={guard.arm}
            onKeyDownCapture={(event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") guard.arm()
            }}
            onPointerLeave={guard.leave}
            onFocusOut={() => requestAnimationFrame(guard.release)}
          >
            {local.children}
          </KobalteTooltip.Trigger>
          <KobalteTooltip.Portal>
            <KobalteTooltip.Content
              ref={(element) => {
                const theme = trigger?.closest("[data-theme]")?.getAttribute("data-theme")
                if (theme) element.setAttribute("data-theme", theme)
              }}
              data-component="tooltip"
              data-placement={props.placement}
              data-force-open={local.forceOpen}
              class={local.contentClass}
              classList={{ "ui-tooltip": true }}
              style={local.contentStyle}
              onPointerDownOutside={(event) => {
                guard.pointerDownOutside(event.target)
                event.preventDefault()
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
