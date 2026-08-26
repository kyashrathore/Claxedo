import type { Edge } from "./types"

export function DropTargetOverlay(props: { edge: Edge }) {
  const zoneClass = (edge: Edge) =>
    [
      "absolute border transition-[opacity,transform,background-color,border-color,box-shadow] duration-100 ease-out",
      props.edge === edge
        ? "opacity-100 scale-100 border-border-strong-base bg-surface-base-active/80 shadow-[var(--shadow-highlight)]"
        : "opacity-25 scale-100 border-border-weak-base/45 bg-surface-base-hover/30",
    ].join(" ")

  return (
    <div class="relative h-full w-full bg-background-base/16 shadow-[var(--shadow-highlight-subtle)] backdrop-blur-[1px]">
      <div class={zoneClass("top")} style={{ top: 0, left: 0, right: 0, height: "32%" }} />
      <div class={zoneClass("bottom")} style={{ bottom: 0, left: 0, right: 0, height: "32%" }} />
      <div class={zoneClass("left")} style={{ top: 0, bottom: 0, left: 0, width: "32%" }} />
      <div class={zoneClass("right")} style={{ top: 0, bottom: 0, right: 0, width: "32%" }} />
    </div>
  )
}
