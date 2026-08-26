import { omit } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Icon, type IconProps } from "./icon"

type Variant = "normal" | "error" | "warning" | "success" | "info"

export interface CardProps extends ComponentProps<"div"> {
  variant?: Variant
  /**
   * Opt in to the `::before` accent rail. The rail is never variant-driven — a plain
   * `variant="error"`/`"warning"` Card must not paint it (D§1: failure whispers).
   * `--card-accent` still tints the title icon regardless of this flag.
   */
  accent?: boolean
}

export interface CardTitleProps extends ComponentProps<"div"> {
  variant?: Variant

  /**
   * Optional title icon.
   *
   * - `undefined`: picks a default icon based on `variant` (error/warning/success/info)
   * - `false`/`null`: disables the icon
   * - `Icon` name: forces a specific icon
   */
  icon?: IconProps["name"] | false | null
}

function pick(variant: Variant) {
  if (variant === "error") return "circle-ban-sign" as const
  if (variant === "warning") return "warning" as const
  if (variant === "success") return "circle-check" as const
  if (variant === "info") return "help" as const
  return
}

function mix(style: ComponentProps<"div">["style"], value?: string) {
  if (!value) return style
  if (!style) return { "--card-accent": value }
  if (typeof style === "string") return `${style};--card-accent:${value};`
  return { ...(style as Record<string, string | number>), "--card-accent": value }
}

export function Card(props: CardProps) {
  const split = props,
    rest = omit(props, "variant", "accent", "style", "class")
  const variant = () => split.variant ?? "normal"
  // Colours the title icon / tool-error icon (both read `--card-accent`). Legacy tokens only —
  // never feeds the rail on its own; the rail requires the separate `accent` opt-in below.
  const accentColor = () => {
    const v = variant()
    if (v === "error") return "var(--icon-critical-base)"
    if (v === "warning") return "var(--icon-warning-base)"
    if (v === "success") return "var(--icon-success-active)"
    if (v === "info") return "var(--icon-info-active)"
    return
  }
  return (
    <div
      {...rest}
      data-component="card"
      data-variant={variant()}
      data-accent={split.accent ? "" : undefined}
      style={mix(split.style, accentColor())}
      class={split.class}
    >
      {props.children}
    </div>
  )
}

export function CardTitle(props: CardTitleProps) {
  const split = props,
    rest = omit(props, "variant", "icon", "class", "children")
  const show = () => split.icon !== false && split.icon !== null
  const name = () => {
    if (split.icon === false || split.icon === null) return
    if (typeof split.icon === "string") return split.icon
    return pick(split.variant ?? "normal")
  }
  const placeholder = () => !name()
  return (
    <div {...rest} data-slot="card-title" class={split.class}>
      {show() ? (
        <span data-slot="card-title-icon" data-placeholder={placeholder() || undefined}>
          <Icon name={name() ?? "dash"} size="small" />
        </span>
      ) : null}
      {split.children}
    </div>
  )
}

export function CardDescription(props: ComponentProps<"div">) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <div {...rest} data-slot="card-description" class={split.class}>
      {split.children}
    </div>
  )
}

export function CardActions(props: ComponentProps<"div">) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <div {...rest} data-slot="card-actions" class={split.class}>
      {split.children}
    </div>
  )
}
