import { splitProps, type ComponentProps } from "solid-js"
import { Icon, type IconName } from "./icon"
import "./card.css"

export type CardVariant = "normal" | "error" | "warning" | "success" | "info"

const variants: Partial<Record<CardVariant, { icon: IconName; accent: string }>> = {
  error: { icon: "circle-ban-sign", accent: "var(--v2-state-fg-danger)" },
  warning: { icon: "warning", accent: "var(--v2-state-fg-warning)" },
  success: { icon: "circle-check", accent: "var(--v2-state-fg-success)" },
  info: { icon: "help", accent: "var(--v2-state-fg-info)" },
}

export interface CardProps extends ComponentProps<"div"> {
  variant?: CardVariant
  accent?: boolean
}

export interface CardTitleProps extends ComponentProps<"div"> {
  variant?: CardVariant
  icon?: IconName | false | null
}

function withAccent(style: ComponentProps<"div">["style"], accent: string | undefined) {
  if (!accent) return style
  if (typeof style === "string") return `${style};--card-accent:${accent};`
  return { ...style, "--card-accent": accent }
}

function CardRoot(props: CardProps) {
  const [split, rest] = splitProps(props, ["variant", "accent", "style", "class", "classList", "children"])
  const variant = () => split.variant ?? "normal"
  return (
    <div
      {...rest}
      data-component="v2-card"
      data-variant={variant()}
      data-accent={split.accent ? "" : undefined}
      style={withAccent(split.style, variants[variant()]?.accent)}
      classList={{ "v2-card": true, ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      {split.children}
    </div>
  )
}

function CardTitle(props: CardTitleProps) {
  const [split, rest] = splitProps(props, ["variant", "icon", "class", "classList", "children"])
  const hidden = () => split.icon === false || split.icon === null
  const name = () => (typeof split.icon === "string" ? split.icon : variants[split.variant ?? "normal"]?.icon)
  return (
    <div {...rest} data-slot="v2-card-title" classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}>
      {hidden() ? null : (
        <span data-slot="v2-card-title-icon" data-placeholder={name() ? undefined : ""}>
          <Icon name={name() ?? "dash"} size="normal" />
        </span>
      )}
      {split.children}
    </div>
  )
}

function CardDescription(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <div {...rest} data-slot="v2-card-description" classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}>
      {split.children}
    </div>
  )
}

function CardActions(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <div {...rest} data-slot="v2-card-actions" classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}>
      {split.children}
    </div>
  )
}

export const Card = Object.assign(CardRoot, {
  Title: CardTitle,
  Description: CardDescription,
  Actions: CardActions,
})
