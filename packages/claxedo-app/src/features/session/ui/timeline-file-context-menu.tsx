// File context menu for timeline file links/paths (T11): right-click a file
// reference in the timeline → Open / Copy path / Reveal in Finder. Pure
// overlay UI over injected callbacks — path resolution and panel opening stay
// with the timeline that owns them.
import { Show } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

export function TimelineFileContextMenu(props: {
  menu: { x: number; y: number; path: string }
  onOpenFile: (path: string) => void
  onDismiss: () => void
  resolvePath: (path: string) => string
  showItemInFolder?: (path: string) => Promise<void> | void
}) {
  return (
    <>
      <div
        class="fixed inset-0 z-[90]"
        onClick={() => props.onDismiss()}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onDismiss()
        }}
      />
      <div
        data-surface="overlay"
        data-overlay-shell="prominent"
        class="fixed z-[91] min-w-40 bg-background-stronger p-1"
        style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
          onClick={() => {
            props.onOpenFile(props.menu.path)
            props.onDismiss()
          }}
        >
          <Icon name="open-file" size="small" /> Open
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
          onClick={() => {
            void navigator.clipboard?.writeText(props.resolvePath(props.menu.path))
            props.onDismiss()
          }}
        >
          <Icon name="copy" size="small" /> Copy path
        </button>
        <Show when={props.showItemInFolder}>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 h-9 text-13-regular text-text-base hover:bg-surface-base-active"
            onClick={() => {
              void props.showItemInFolder?.(props.resolvePath(props.menu.path))
              props.onDismiss()
            }}
          >
            <Icon name="folder" size="small" /> Reveal in Finder
          </button>
        </Show>
      </div>
    </>
  )
}
