import { createEffect, createSignal, on, type JSX } from "solid-js"
import { Tooltip } from "@/ui"
import type { HoverEngagement } from "../hover-engagement"

type TitleMotion = { readonly distance: number; readonly duration: number }

function titleMotion(clip: HTMLElement): TitleMotion {
  const width = clip.clientWidth
  const textWidth = clip.firstElementChild!.getBoundingClientRect().width
  if (textWidth <= width) return { distance: 0, duration: 0 }
  const action = clip.closest('[data-component="navigation-row"]')?.querySelector<HTMLElement>(".ui-session-navigation-settle")
  const overlap = action ? Math.max(0, clip.getBoundingClientRect().right - action.getBoundingClientRect().left) : 0
  const distance = textWidth - width + overlap + 4
  return { distance, duration: distance / 35 * 1000 }
}

export function SessionNavigationTitle(props: { readonly value: string; readonly engagement: HoverEngagement; readonly class?: string }): JSX.Element {
  let clip: HTMLSpanElement | undefined
  const [motion, setMotion] = createSignal({ distance: 0, duration: 0 })
  const focused = () => {
    const target = props.engagement.focusedTarget()
    return !props.engagement.hovered() && target?.getAttribute("data-slot") === "navigation-row-activate" && target.matches(":focus-visible")
  }
  createEffect(on([props.engagement.hovered, () => props.value], ([hovered]): void => {
    if (!hovered || !clip || !matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return void setMotion({ distance: 0, duration: 0 })
    setMotion(titleMotion(clip))
  }))
  return (
    <Tooltip value={props.value} inactive={!focused()} forceOpen={focused()} class="min-w-0 flex-1" contentClass="ui-session-tooltip">
      <span ref={clip} data-slot="session-navigation-title" data-overflow={motion().distance > 0 ? "true" : undefined} class={`ui-session-title min-w-0 flex-1 ${props.class ?? ""}`} style={{ "--session-title-distance": `${motion().distance}px`, "--session-title-duration": `${motion().duration}ms` }}>
        <span data-slot="session-title-text" class="ui-session-title-text">{props.value}</span>
      </span>
    </Tooltip>
  )
}
