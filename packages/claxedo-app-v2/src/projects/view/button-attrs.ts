export type ButtonVariant = "neutral" | "danger" | "outline" | "contrast" | "ghost" | "ghost-muted"

export function buttonAttrs(variant: ButtonVariant, size: "normal" | "large" = "large") {
  return {
    class: "ui-button-v2",
    "data-component": "button-v2",
    "data-size": size,
    "data-variant": variant,
  } as const
}
