import { Show, type JSX } from "solid-js"
import { Icon, type IconProps } from "@/ui"

export interface ActivityRowProps {
  icon?: IconProps["name"]
  verb: JSX.Element
  tail?: JSX.Element
  accessory?: JSX.Element
  expanded?: boolean
  onToggle?: () => void
  hasContent?: boolean
  active?: boolean
  nested?: boolean
  class?: string
  ariaLabel?: string
}

export function ActivityRow(props: ActivityRowProps) {
  const showChevron = () => props.hasContent !== false && !!props.onToggle
  return (
    <div
      class={`activity-row${props.class ? ` ${props.class}` : ""}`}
      data-expanded={props.expanded ? "true" : undefined}
      data-active={props.active ? "true" : undefined}
      data-nested={props.nested ? "true" : undefined}
    >
      <Show when={props.onToggle}>
        <button
          type="button"
          class="activity-row__hit"
          aria-expanded={props.hasContent !== false ? props.expanded === true : undefined}
          aria-label={props.ariaLabel}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggle?.()
          }}
        />
      </Show>
      <Show when={props.icon && !props.nested}>
        <span class="activity-row__icon">
          <Icon name={props.icon!} size="small" />
        </span>
      </Show>
      <span class="activity-row__summary">
        <span class="activity-row__verb">{props.verb}</span>
        <Show when={props.tail !== undefined}>
          <span class="activity-row__tail">{props.tail}</span>
        </Show>
      </span>
      <Show when={props.accessory !== undefined}>
        <span class="activity-row__accessory">{props.accessory}</span>
      </Show>
      <Show when={showChevron()}>
        <span class="activity-row__chevron">
          <Icon name="chevron-right" size="small" />
        </span>
      </Show>
    </div>
  )
}
