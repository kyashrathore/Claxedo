import { Show } from "solid-js"
import { Button, type ButtonProps } from "@/ui"
import { surfaceIconName } from "../icon-names"
import type { SurfaceNodeProps } from "../model"
import { isDestructiveIcon, useRowActionRole } from "./row-actions"
import { SurfaceIcon } from "./surface-icon"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

type ButtonVariant = NonNullable<SurfaceNodeProps<"Button">["def"]["variant"]>

const BUTTON_VARIANTS: Record<ButtonVariant, NonNullable<ButtonProps["variant"]>> = {
  primary: "contrast",
  default: "neutral",
  borderless: "ghost",
}

export function ButtonView(props: SurfaceNodeProps<"Button">) {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const role = useRowActionRole()
  const icon = () => surfaceIconName(read.value(props.def.icon, props.scope))
  const iconOnly = () => role === "row-secondary" && icon() !== undefined
  const variant = (): NonNullable<ButtonProps["variant"]> => {
    if (role === "row-primary") return "neutral"
    if (role === "row-secondary") return iconOnly() ? "ghost" : "neutral"
    return BUTTON_VARIANTS[props.def.variant ?? "default"]
  }
  const label = () => {
    const child = runtime.state.components.get(props.def.child)
    return child?.component === "Text" ? read.text(child.text, props.scope) : undefined
  }
  return (
    <Button
      data-slot="surface-button"
      data-row-action={role}
      data-icon-only={iconOnly() ? "true" : "false"}
      data-destructive={isDestructiveIcon(icon()) ? "true" : "false"}
      variant={variant()}
      title={iconOnly() ? label() : undefined}
      disabled={runtime.actionsDisabled()}
      onClick={() => runtime.fire(props.def.action, props.def.id, props.scope)}
    >
      <Show when={icon()}>{(name) => <SurfaceIcon name={name()} size="small" />}</Show>
      <span data-slot="surface-button-label" classList={{ "sr-only": iconOnly() }}>
        <SurfaceNode id={props.def.child} scope={props.scope} />
      </span>
    </Button>
  )
}
