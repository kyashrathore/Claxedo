import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { Region } from "./region"
import { SidebarGrip } from "./sidebar-grip"

export type SidebarProps = {
  readonly mode: "main" | "settings"
  readonly main: JSX.Element
  readonly settings: JSX.Element
}

function SidebarHeader(): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const label = () => (layout.sidebarPinned() ? t("shell.hideSidebar") : t("shell.pinSidebar"))
  return (
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border-weaker-base bg-background-base px-1">
      <Tooltip placement="bottom" value={label()}>
        <div class="max-md:hidden shrink-0">
          <IconButton
            icon={layout.sidebarPinned() ? "layout-left-full" : "layout-left-partial"}
            variant="ghost"
            class="size-6 rounded-sm text-icon-weak-base hover:text-icon-base"
            onClick={() => layout.send({ type: "toggleSidebar" })}
            aria-label={label()}
            aria-pressed={layout.sidebarPinned() ? "true" : "false"}
            data-icon-interaction="binary"
            data-testid="sidebar-toggle"
          />
        </div>
      </Tooltip>
      <div class="flex-1" />
    </div>
  )
}

export function SidebarContent(props: SidebarProps & { readonly width?: number; readonly open?: boolean; readonly onMouseLeave?: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const open = () => props.open !== false
  return (
    <nav
      data-testid="rail-sidebar"
      data-surface="sidebar"
      data-mode={props.mode}
      data-open={open() ? "true" : "false"}
      aria-label={t("shell.navigation")}
      class="h-full flex flex-col bg-background-base overflow-hidden z-[50] pointer-events-auto claxedo-rail-sidebar-panel transition-[opacity,transform] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] max-md:!w-full max-md:opacity-100 max-md:pointer-events-auto"
      classList={{ "opacity-100": open(), "md:opacity-0 md:pointer-events-none": !open() }}
      style={{ width: props.width === undefined ? undefined : `${props.width}px`, "border-right": "1px solid var(--shell-border-sidebar, var(--border-weaker-base))" }}
      onMouseLeave={() => props.onMouseLeave?.()}
    >
      <SidebarHeader />
      <Region name="sidebar">
        <Show when={props.mode === "settings"} fallback={props.main}>
          {props.settings}
        </Show>
      </Region>
    </nav>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const layout = useShellLayout()
  const expanded = () => layout.sidebarShown()
  return (
    <div
      class="relative flex flex-col w-[var(--claxedo-sidebar-width)] shrink-0 overflow-hidden transition-[width] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]"
      classList={{
        "pointer-events-none": !expanded(),
        "pointer-events-auto": expanded(),
        "absolute left-0 top-0 bottom-0 z-[80]": !layout.sidebarPinned(),
      }}
      style={{ "--claxedo-sidebar-width": `${expanded() ? layout.sidebarWidth() : 0}px` }}
      data-testid="sidebar"
    >
      <div class="flex-1 min-h-0 h-full">
        <SidebarContent {...props} width={layout.sidebarWidth()} open={expanded()} onMouseLeave={() => layout.send({ type: "unpeekSidebar" })} />
      </div>
      <Show when={expanded()}>
        <SidebarGrip />
      </Show>
    </div>
  )
}
