import { Show, type Component } from "solid-js"
import type { BadgeProps, ButtonProps, IconButtonProps, IconProps, LoaderProps, TooltipProps } from "@claxedo/plugin-api"

export const Icon: Component<IconProps> = (props) => (
  <span data-plugin-icon={props.name} data-size={props.size ?? "normal"} class={props.class} aria-hidden="true" />
)

export const Button: Component<ButtonProps> = (props) => (
  <button
    type={props.type ?? "button"}
    data-variant={props.variant ?? "neutral"}
    data-size={props.size ?? "normal"}
    class={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${props.class ?? ""}`}
    disabled={props.disabled}
    aria-label={props["aria-label"]}
    data-testid={props["data-testid"]}
    onClick={(event) => props.onClick?.(event)}
  >
    <Show when={props.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
    {props.children}
  </button>
)

export const IconButton: Component<IconButtonProps> = (props) => (
  <button
    type="button"
    data-variant={props.variant ?? "neutral"}
    data-size={props.size ?? "normal"}
    class={`inline-flex size-8 items-center justify-center rounded-md ${props.class ?? ""}`}
    disabled={props.disabled}
    aria-label={props.label}
    title={props.label}
    data-testid={props["data-testid"]}
    onClick={(event) => props.onClick?.(event)}
  >
    <Icon name={props.icon} size="small" />
  </button>
)

export const Badge: Component<BadgeProps> = (props) => (
  <span data-tone={props.tone ?? "neutral"} class="inline-flex rounded-full border px-2 py-0.5 text-xs">
    {props.children}
  </span>
)

export const Tooltip: Component<TooltipProps> = (props) => (
  <span title={props.label} class="contents">
    {props.children}
  </span>
)

export const Loader: Component<LoaderProps> = (props) => (
  <span role="status" aria-live="polite" class="text-sm">
    {props.label}
  </span>
)
