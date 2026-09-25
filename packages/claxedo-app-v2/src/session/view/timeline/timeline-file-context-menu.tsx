import { ClaxedoIcon as Icon } from "@/ui"

export function TimelineFileContextMenu(props: {
  menu: { x: number; y: number; path: string }
  onOpenFile: (path: string) => void
  onDismiss: () => void
  resolvePath: (path: string) => string
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
      </div>
    </>
  )
}
