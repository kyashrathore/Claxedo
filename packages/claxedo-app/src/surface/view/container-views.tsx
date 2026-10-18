import { createSignal, Index, onCleanup, onMount } from "solid-js"
import { Card, Collapsible, Tabs } from "@/ui"
import type { SurfaceNodeProps } from "../model"
import { tabStripEdge, type TabStripEdge } from "../tab-strip"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader } from "./surface-runtime"

export function CardView(props: SurfaceNodeProps<"Card">) {
  return (
    <Card data-slot="surface-card">
      <SurfaceNode id={props.def.child} scope={props.scope} />
    </Card>
  )
}

function watchTabStrip(list: HTMLElement, onEdge: (edge: TabStripEdge) => void): () => void {
  const measure = () => onEdge(tabStripEdge(list.scrollLeft, list.clientWidth, list.scrollWidth))
  const observer = new ResizeObserver(measure)
  observer.observe(list)
  list.addEventListener("scroll", measure, { passive: true })
  measure()
  return () => {
    observer.disconnect()
    list.removeEventListener("scroll", measure)
  }
}

function revealSelectedTab(list: HTMLElement | undefined) {
  list?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

export function TabsView(props: SurfaceNodeProps<"Tabs">) {
  const read = useSurfaceReader()
  const [edge, setEdge] = createSignal<TabStripEdge>("none")
  let list: HTMLDivElement | undefined
  onMount(() => {
    if (list) onCleanup(watchTabStrip(list, setEdge))
  })
  return (
    <Tabs defaultValue="0" data-slot="surface-tabs" onChange={() => queueMicrotask(() => revealSelectedTab(list))}>
      <Tabs.List ref={list} data-edge={edge()}>
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
        <Collapsible.Arrow />
        <span data-slot="surface-collapsible-title">{read.text(props.def.title, props.scope)}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <SurfaceNode id={props.def.child} scope={props.scope} />
      </Collapsible.Content>
    </Collapsible>
  )
}
