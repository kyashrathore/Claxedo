/**
 * An OS window-drag surface for the titlebar strips. `data-window-drag-region`
 * (base.css maps it to `-webkit-app-region: drag`) is what actually moves the
 * frameless Electron window; interactive descendants opt back out via the
 * `no-drag` rules in the same stylesheet. macOS handles double-click-to-zoom on
 * the drag region natively, so no JS is involved.
 *
 * Used to reserve grabbable space in the packed compact header — a fixed handle
 * after the sidebar icon and a flexible filler after the tabs.
 */
export function TitlebarDragRegion(props: { class?: string }) {
  return (
    <div
      data-window-drag-region
      data-testid="titlebar-drag-region"
      aria-hidden="true"
      class={`self-stretch ${props.class ?? ""}`}
    />
  )
}
