import { Show } from "solid-js"
import { Button, Icon, type ButtonProps } from "@/ui"
import { surfaceIcon } from "../icon-names"
import type { SurfaceNodeProps } from "../model"
import { SurfaceNode } from "./surface-node"
import { useSurfaceRuntime } from "./surface-runtime"

type ButtonVariant = NonNullable<SurfaceNodeProps<"Button">["def"]["variant"]>

const BUTTON_VARIANTS: Record<ButtonVariant, NonNullable<ButtonProps["variant"]>> = {
  primary: "contrast",
  default: "neutral",
  borderless: "ghost",
}

export function ButtonView(props: SurfaceNodeProps<"Button">) {
  const runtime = useSurfaceRuntime()
  const variant = () => props.def.variant ?? "default"
  return (
    <Button
      data-slot="surface-button"
      variant={BUTTON_VARIANTS[variant()]}
      disabled={runtime.actionsDisabled()}
      onClick={() => runtime.fire(props.def.action, props.def.id, props.scope)}
    >
      <Show when={surfaceIcon(props.def.icon)}>{(name) => <Icon name={name()} size="small" />}</Show>
      <SurfaceNode id={props.def.child} scope={props.scope} />
    </Button>
  )
}
