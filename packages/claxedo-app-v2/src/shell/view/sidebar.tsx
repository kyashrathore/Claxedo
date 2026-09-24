import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { trackRailPeek } from "./rail-peek"
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

export function SidebarContent(
  props: SidebarProps & { readonly width?: number; readonly open?: boolean; readonly onMouseLeave?: () => void; readonly ref?: (element: HTMLElement) => void },
): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const open = () => props.open !== false
  return (
    <nav
      ref={(element) => props.ref?.(element)}
      data-sidebar
      data-claxedo-compact-touch
      data-pinned={layout.sidebarPinned() ? "" : undefined}
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

function PhoneOpener(): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const open = () => layout.phone() && layout.sidebarShown()
  return (
    <button
      type="button"
      data-testid="mobile-sidebar-opener"
      data-claxedo-compact-touch
      aria-label={open() ? t("shell.closeNavigation") : t("shell.openNavigation")}
      aria-expanded={open()}
      aria-pressed={open()}
      data-icon-interaction="binary"
      class="md:hidden fixed left-1 top-[3px] z-[110] flex h-8 w-8 items-center justify-center rounded bg-transparent text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
      onClick={() => layout.send({ type: open() ? "hideSidebar" : "showSidebar" })}
    >
      <Icon name={open() ? "layout-left-full" : "layout-left-partial"} size="small" />
    </button>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const layout = useShellLayout()
  const expanded = () => layout.sidebarShown()
  const drawerOpen = () => layout.phone() && expanded()
  let nav: HTMLElement | undefined
  trackRailPeek(layout, () => nav?.getBoundingClientRect())
  return (
    <>
      <PhoneOpener />
      <div
        class="relative flex flex-col w-[var(--claxedo-sidebar-width)] shrink-0 overflow-hidden transition-[width] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] max-md:fixed max-md:inset-0 max-md:z-[100] max-md:!w-auto max-md:pointer-events-auto max-md:transition-[translate,transform] max-md:duration-300 max-md:ease-in-out"
        classList={{
          "pointer-events-none": !expanded(),
          "pointer-events-auto": expanded(),
          "md:absolute md:left-0 md:top-0 md:bottom-0 md:z-[80]": !layout.sidebarPinned(),
          "max-md:translate-x-0": drawerOpen(),
          "max-md:-translate-x-full": !drawerOpen(),
        }}
        style={{ "--claxedo-sidebar-width": `${expanded() ? layout.sidebarWidth() : 0}px` }}
        data-testid="sidebar"
      >
        <div class="flex-1 min-h-0 h-full">
          <SidebarContent
            {...props}
            ref={(element) => (nav = element)}
            width={layout.sidebarWidth()}
            open={expanded()}
            onMouseLeave={() => layout.send({ type: "unpeekSidebar" })}
          />
        </div>
        <Show when={expanded() && !layout.phone()}>
          <SidebarGrip />
        </Show>
      </div>
    </>
  )
}
