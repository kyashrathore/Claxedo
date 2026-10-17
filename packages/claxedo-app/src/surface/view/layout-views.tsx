import type { JSX } from "solid-js"
import type { SurfaceNodeProps } from "../model"
import { SurfaceChildren } from "./surface-children"

type Justify = NonNullable<SurfaceNodeProps<"Row">["def"]["justify"]>
type Align = NonNullable<SurfaceNodeProps<"Row">["def"]["align"]>

const JUSTIFY: Record<Justify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
  stretch: "stretch",
}

const ALIGN: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
}

function flexStyle(justify: Justify | undefined, align: Align | undefined): JSX.CSSProperties {
  return { "justify-content": JUSTIFY[justify ?? "start"], "align-items": ALIGN[align ?? "stretch"] }
}

export function RowView(props: SurfaceNodeProps<"Row">) {
  return (
    <div data-slot="surface-flex" data-direction="row" style={flexStyle(props.def.justify, props.def.align ?? "center")}>
      <SurfaceChildren list={props.def.children} scope={props.scope} weighted />
    </div>
  )
}

export function ColumnView(props: SurfaceNodeProps<"Column">) {
  return (
    <div data-slot="surface-flex" data-direction="column" style={flexStyle(props.def.justify, props.def.align)}>
      <SurfaceChildren list={props.def.children} scope={props.scope} weighted />
    </div>
  )
}

export function SurfaceListView(props: SurfaceNodeProps<"List">) {
  return (
    <div data-slot="surface-flex" data-direction={props.def.direction === "horizontal" ? "row" : "column"} style={flexStyle(undefined, props.def.align)}>
      <SurfaceChildren list={props.def.children} scope={props.scope} weighted={false} />
    </div>
  )
}

export function DividerView(props: SurfaceNodeProps<"Divider">) {
  return <div role="separator" data-slot="surface-divider" aria-orientation={props.def.axis ?? "horizontal"} />
}
