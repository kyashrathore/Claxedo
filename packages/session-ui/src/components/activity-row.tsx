import { Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"

export interface ActivityRowProps {
  /** Category icon (muted); hidden when nested inside a group. */
  icon?: IconProps["name"]
  /** Leading verb — reads at --text-base, brightens to --text-strong on hover. */
  verb: JSX.Element
  /** Trailing detail — single line, truncated, whispers at --text-weak. */
  tail?: JSX.Element
  /** Right-aligned accessory (diffstat, elapsed, status dot). */
  accessory?: JSX.Element
  /** Expanded state — rotates the chevron, mirrors aria-expanded. */
  expanded?: boolean
  /** Toggle handler; when present the overlay button toggles and shows a chevron. */
  onToggle?: () => void
  /** Whether the row has expandable content (controls chevron visibility). */
  hasContent?: boolean
  /** Marks the row as active/running (data-active for callers to style). */
  active?: boolean
  /** Nested inside a WorkGroup — dimmer, icon-less. */
  nested?: boolean
  /** Extra class on the row shell. */
  class?: string
  /** Accessible label for the overlay toggle button. */
  ariaLabel?: string
}

/**
 * ActivityRow — the muted activity-row primitive (T0.1). One anatomy for every tool row,
 * group header, file row, and turn-fold row: muted icon, verb + truncated tail, hover
 * brighten, and a chevron that fades in exactly at the pointer. See activity-row.css.
 */
export function ActivityRow(props: ActivityRowProps) {
  const showChevron = () => props.hasContent !== false && !!props.onToggle
  return (
    <div
      class={`activity-row${props.class ? ` ${props.class}` : ""}`}
      data-component="activity-row"
      data-expanded={props.expanded ? "true" : undefined}
      data-active={props.active ? "true" : undefined}
      data-nested={props.nested ? "true" : undefined}
    >
      <Show when={props.onToggle}>
        <button
          type="button"
          class="activity-row__hit"
          aria-expanded={
            (props.hasContent !== false ? props.expanded === true : undefined) == null
              ? undefined
              : (props.hasContent !== false ? props.expanded === true : undefined)
                ? "true"
                : "false"
          }
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
