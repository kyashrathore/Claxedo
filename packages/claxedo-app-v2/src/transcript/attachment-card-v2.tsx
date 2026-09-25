import type { JSX } from "solid-js"
import "./attachment-card-v2.css"

export function AttachmentCardV2(props: {
  title: string
  active?: boolean
  clickable?: boolean
  wide?: boolean
  surface?: "base"
  hover?: string
  titleRef?: (element: HTMLSpanElement) => void
  onClick?: () => void
  children: JSX.Element
}) {
  return (
    <div
      data-component="attachment-card-v2"
      data-active={props.active ? "true" : undefined}
      data-clickable={props.clickable ? "true" : undefined}
      data-wide={props.wide ? "true" : undefined}
      data-surface={props.surface}
      title={props.hover}
      onClick={() => props.onClick?.()}
    >
      <span ref={(element) => props.titleRef?.(element)} class="ui-attachment-card-v2-title">
        {props.title}
      </span>
      <span class="ui-attachment-card-v2-subtitle">{props.children}</span>
    </div>
  )
}
