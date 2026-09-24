import { createEffect, createMemo, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useCommands } from "@/shell"
import { useDragSource, useWorkbench } from "@/workbench"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { dictionary } from "../i18n"
import { useSwitcherItems, type SwitcherItem } from "../switcher-items"
import { SwitcherCard, SwitcherPrefixMark } from "./switcher-card"

const ACTIVE_SCROLL_DELAY_MS = 120
const COMMAND_HINT_HOLD_MS = 500
const SURFACE_SHORTCUT_COUNT = 9

function surfaceCommandId(index: number): string {
  return `claxedo.surface.${index + 1}`
}

function useCommandHints(strip: () => HTMLElement | undefined): void {
  let hold: ReturnType<typeof setTimeout> | undefined
  const hide = () => {
    if (hold) clearTimeout(hold)
    hold = undefined
    strip()?.removeAttribute("data-command-hints")
  }
  const down = (event: KeyboardEvent) => {
    if (event.key !== "Meta" || hold || strip()?.hasAttribute("data-command-hints")) return
    hold = setTimeout(() => {
      hold = undefined
      strip()?.setAttribute("data-command-hints", "true")
    }, COMMAND_HINT_HOLD_MS)
  }
  const up = (event: KeyboardEvent) => event.key === "Meta" && hide()
  onMount(() => {
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", hide)
    onCleanup(() => {
      hide()
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", hide)
    })
  })
}

function useActiveScroll(strip: () => HTMLElement | undefined, active: Accessor<HTMLElement | undefined>): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const element = active()
    const parent = strip()
    if (!element || !parent) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const offset = element.getBoundingClientRect()
      const bounds = parent.getBoundingClientRect()
      const left = offset.left - bounds.left
      const right = offset.right - bounds.right
      if (left >= 0 && right <= 0) return
      parent.scrollTo({ left: parent.scrollLeft + (left < 0 ? left : right), behavior: "smooth" })
    }, ACTIVE_SCROLL_DELAY_MS)
  })
  onCleanup(() => timer && clearTimeout(timer))
}

function draggable(item: SwitcherItem): boolean {
  return item.kind === "session" || item.kind === "terminal"
}

function SwitcherTab(props: { readonly item: SwitcherItem; readonly active: boolean; readonly hint: string | undefined; readonly onElement: (element: HTMLElement) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const workbench = useWorkbench()
  const select = () => workbench.navigation.show(props.item.contentId)
  const close = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    workbench.closeContent(props.item.contentId)
  }
  const drag = (element: HTMLElement) =>
    onCleanup(
      useDragSource(workbench.drag, element, {
        contentId: () => (draggable(props.item) ? props.item.contentId : undefined),
        sourceKind: "tab",
        label: () => props.item.title,
        enabled: () => draggable(props.item),
        touchAction: "pan-x",
      }),
    )
  return (
    <div data-testid="compact-switcher-tab" data-content-id={props.item.contentId} data-claxedo-compact-touch class="group relative h-7 min-w-[118px] max-w-[220px] shrink-0" ref={props.onElement}>
      <div
        data-slot="workbench-tab"
        data-selected={props.active ? "true" : undefined}
        class="flex h-7 w-full min-w-0 max-w-[220px] shrink-0 items-stretch gap-0 rounded-md border border-transparent py-0 pl-1.5 pr-7 text-left text-sm leading-none transition-[background-color,color] duration-100"
        classList={{
          "bg-surface-base-hover text-text-base": props.active,
          "text-text-weak group-hover:bg-surface-base-hover/35 group-hover:text-text-base group-focus-within:bg-surface-base-hover/35 group-focus-within:text-text-base": !props.active,
        }}
      >
        <Tooltip value={<SwitcherCard item={props.item} />} placement="bottom-start" openDelay={240} contentClass="theme-overlay-bare z-[260] p-0 border-none bg-transparent shadow-none" class="flex h-full w-5 shrink-0 items-center">
          <button
            type="button"
            aria-label={`${props.item.projectLabel ?? t("rail.global")} / ${props.item.workspaceLabel ?? t("rail.global")}`}
            data-testid="switcher-prefix-trigger"
            draggable={false}
            class="relative flex h-full w-full shrink-0 items-center border-none bg-transparent p-0 outline-none"
            onClick={select}
          >
            <SwitcherPrefixMark item={props.item} active={props.active} />
          </button>
        </Tooltip>
        <button
          type="button"
          aria-label={props.item.title}
          data-testid="switcher-title-button"
          aria-current={props.active ? "page" : undefined}
          ref={drag}
          onClick={select}
          onAuxClick={(event) => event.button === 1 && close(event)}
          class="ml-1 flex h-full min-w-0 flex-1 items-center border-none bg-transparent p-0 text-left text-sm leading-none text-inherit outline-none"
        >
          <span data-testid="switcher-title" class="min-w-0 flex-1 truncate">
            {props.item.title}
          </span>
        </button>
      </div>
      <button
        type="button"
        aria-label={t("rail.closeTab", { title: props.item.title })}
        class="absolute right-1 top-1/2 z-10 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-sm border-none bg-transparent p-0 text-icon-weak-base opacity-0 outline-none transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-base hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-surface-base-hover group-hover:opacity-100"
        classList={{ "opacity-65": props.active, "group-data-[command-hints]/switcher:hidden": !!props.hint }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={close}
      >
        <Icon name="close-small" size="small" />
      </button>
      <Show when={props.hint}>
        {(hint) => (
          <span
            aria-hidden="true"
            data-testid="switcher-command-hint"
            class="absolute right-1 top-1/2 z-20 hidden h-5 min-w-7 -translate-y-1/2 items-center justify-center rounded-md bg-surface-base-hover px-1.5 text-11-medium text-text-weak group-data-[command-hints]/switcher:flex"
          >
            {hint()}
          </span>
        )}
      </Show>
    </div>
  )
}

export function CompactSwitcher(): JSX.Element {
  const t = useTranslator(dictionary)
  const workbench = useWorkbench()
  const commands = useCommands()
  const hint = (index: number) => {
    const id = surfaceCommandId(index)
    return index < SURFACE_SHORTCUT_COUNT && commands.has(id) ? commands.keybind(id) : undefined
  }
  const items = useSwitcherItems()
  const byId = createMemo(() => new Map(items().map((item) => [item.contentId, item])))
  const elements = new Map<string, HTMLElement>()
  let strip: HTMLElement | undefined
  useCommandHints(() => strip)
  useActiveScroll(
    () => strip,
    () => {
      const focused = workbench.selectors.focusedContent()
      return focused ? elements.get(focused) : undefined
    },
  )
  return (
    <nav
      ref={strip}
      aria-label={t("rail.workbenchPanes")}
      data-testid="compact-switcher"
      class="group/switcher flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1"
      style={{ "scrollbar-width": "none" }}
    >
      <For each={items().map((item) => item.contentId)}>
        {(contentId, index) => (
          <Show when={byId().get(contentId)}>
            {(item) => (
              <SwitcherTab
                item={item()}
                active={workbench.selectors.focusedContent() === contentId}
                hint={hint(index())}
                onElement={(element) => {
                  elements.set(contentId, element)
                  onCleanup(() => elements.delete(contentId))
                }}
              />
            )}
          </Show>
        )}
      </For>
    </nav>
  )
}
