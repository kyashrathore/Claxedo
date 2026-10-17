import { Index } from "solid-js"
import { Card, Collapsible, Tabs } from "@/ui"
import type { SurfaceNodeProps } from "../model"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader } from "./surface-runtime"

export function CardView(props: SurfaceNodeProps<"Card">) {
  return (
    <Card data-slot="surface-card">
      <SurfaceNode id={props.def.child} scope={props.scope} />
    </Card>
  )
}

export function TabsView(props: SurfaceNodeProps<"Tabs">) {
  const read = useSurfaceReader()
  return (
    <Tabs defaultValue="0" data-slot="surface-tabs">
      <Tabs.List>
        <Index each={props.def.tabs}>
          {(tab, index) => <Tabs.Trigger value={String(index)}>{read.text(tab().title, props.scope)}</Tabs.Trigger>}
        </Index>
      </Tabs.List>
      <Index each={props.def.tabs}>
        {(tab, index) => (
          <Tabs.Content value={String(index)}>
            <SurfaceNode id={tab().child} scope={props.scope} />
          </Tabs.Content>
        )}
      </Index>
    </Tabs>
  )
}

export function CollapsibleView(props: SurfaceNodeProps<"Collapsible">) {
  const read = useSurfaceReader()
  return (
    <Collapsible variant="ghost" defaultOpen={props.def.open ?? false} data-slot="surface-collapsible">
      <Collapsible.Trigger>
        <span>{read.text(props.def.title, props.scope)}</span>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <SurfaceNode id={props.def.child} scope={props.scope} />
      </Collapsible.Content>
    </Collapsible>
  )
}
