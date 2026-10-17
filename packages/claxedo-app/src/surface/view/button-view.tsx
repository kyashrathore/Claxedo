import { Button, type ButtonProps } from "@/ui"
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
  return (
    <Button
      variant={BUTTON_VARIANTS[props.def.variant ?? "default"]}
      size="small"
      disabled={runtime.actionsDisabled()}
      onClick={() => runtime.fire(props.def.action, props.def.id, props.scope)}
    >
      <SurfaceNode id={props.def.child} scope={props.scope} />
    </Button>
  )
}
