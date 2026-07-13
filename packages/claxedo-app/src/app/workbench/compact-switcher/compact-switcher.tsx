import { For, Show, createEffect, onCleanup } from "solid-js"
import type { SwitcherItem } from "./switcher-items"
import { useDragSource } from "../workbench/index"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"

const ACTIVE_SCROLL_DELAY_MS = 120
const SWITCH_COMMIT_DELAY_MS = 48

export type CompactSwitcherProps = {
  items?: SwitcherItem[]
  onSelect?: (contentId: string) => void
  onClose?: (contentId: string) => void
  onDragStart?: (contentId: string) => void
  onDragEnd?: () => void
}

function compactLabel(label: string | undefined, fallback: string) {
  const value = label?.trim().replace(/\s+/g, "") || fallback
  return value.slice(0, 1).toLowerCase()
}

function workspaceLabel(item: SwitcherItem) {
  const label = item.workspaceLabel ?? item.workspaceDir?.split("/").filter(Boolean).at(-1) ?? "Global"
  return compactLabel(label, "Global")
}

function projectLabel(item: SwitcherItem) {
  return compactLabel(item.projectLabel ?? item.workspaceDir?.split("/").filter(Boolean).at(-1), "Global")
}

function identityLabel(item: SwitcherItem) {
  return `${projectLabel(item)}/${workspaceLabel(item)}`
}

function fallback(value: string | undefined, empty = "Not available") {
  return value?.trim() || empty
}

function hasVisibleStatus(item: SwitcherItem) {
  return !!item.status && item.status !== "idle"
}

function StatusDot(props: { status?: SwitcherItem["status"] }) {
  // Minimal status palette, kept in sync with NavigationStatusDot (navigation-
  // row.tsx): grey for working/done, red only for "needs you", nothing for idle.
  //   working → pulsing grey · done → solid grey · permission → solid red
  if (!props.status || props.status === "idle") return null
  return (
    <span
      aria-hidden="true"
      data-switcher-status={props.status}
      class="inline-flex size-1.5 shrink-0 rounded-full"
      classList={{
        "bg-text-weak": props.status === "working" || props.status === "done",
        "animate-pulse": props.status === "working",
        "bg-icon-critical-base": props.status === "permission",
      }}
    />
  )
}

function SwitcherPrefixMark(props: { item: SwitcherItem; active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="switcher-identity"
      class="flex h-full w-5 shrink-0 items-center text-[10px] font-medium leading-none text-text-weaker transition-opacity duration-100"
      classList={{
        "justify-center opacity-100": hasVisibleStatus(props.item),
        "justify-start opacity-30 group-hover:opacity-55 group-focus-within:opacity-55":
          !hasVisibleStatus(props.item) && !props.active,
        "justify-start opacity-55": !hasVisibleStatus(props.item) && props.active,
      }}
    >
      <Show
        when={hasVisibleStatus(props.item)}
        fallback={
          <span data-switcher-compact-label class="whitespace-nowrap">
            {identityLabel(props.item)}
          </span>
        }
      >
        <StatusDot status={props.item.status} />
      </Show>
    </span>
  )
}

function MetadataRow(props: { icon: ClaxedoIconProps["name"]; label: string; value: string }) {
  return (
    <div class="grid grid-cols-[20px_76px_minmax(0,1fr)] items-center gap-2">
      <span class="flex size-5 items-center justify-center rounded bg-surface-base-hover/45 text-icon-weak-base">
        <Icon name={props.icon} size="small" />
      </span>
      <span class="text-[10px] font-medium uppercase tracking-[0.08em] text-text-weaker">
        {props.label}
      </span>
      <span class="min-w-0 truncate text-[12px] font-medium text-text-base">
        {props.value}
      </span>
    </div>
  )
}

function SwitcherMetadataCard(props: { item: SwitcherItem }) {
  return (
    <div class="w-[320px] rounded-lg border border-border-weak-base/70 bg-background-base/95 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.42)] backdrop-blur">
      <div class="mb-3 flex items-start gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-weak-base/55 bg-surface-base-hover/50 text-[11px] font-semibold text-text-weak">
          {identityLabel(props.item)}
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-semibold text-text-base">
            {fallback(props.item.title, "Untitled session")}
          </div>
          <div class="mt-0.5 truncate text-[11px] text-text-weaker">
            {fallback(props.item.projectLabel, "Global")} · {fallback(props.item.workspaceLabel, "Global")}
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <MetadataRow icon="folder" label="Project" value={fallback(props.item.projectLabel, "Global")} />
        <MetadataRow icon="link" label="Git Repo" value={fallback(props.item.gitRepo)} />
        <MetadataRow icon="branch" label="Branch" value={fallback(props.item.gitBranch)} />
        <MetadataRow icon="file-tree" label="Worktree" value={fallback(props.item.workspaceDir ?? props.item.projectWorktree)} />
        <MetadataRow icon="laptop" label="Workspace" value={fallback(props.item.workspaceLabel, "Global")} />
      </div>
    </div>
  )
}

function canDrag(item: SwitcherItem) {
  return item.kind === "session" || item.kind === "terminal"
}

export function CompactSwitcher(props: CompactSwitcherProps) {
  const itemElements = new Map<string, HTMLDivElement>()
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let selectTimer: ReturnType<typeof setTimeout> | undefined
  const items = () => props.items ?? []
  const activeItem = () => items().find((item) => item.active)

  createEffect(() => {
    const ids = new Set(items().map((item) => item.contentId))
    itemElements.forEach((_, id) => {
      if (!ids.has(id)) itemElements.delete(id)
    })
  })

  createEffect(() => {
    const item = activeItem()
    if (!item) return
    const element = itemElements.get(item.contentId)
    if (!element?.scrollIntoView) return
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const parent = element.parentElement
      if (!parent) return
      const elementRect = element.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      if (elementRect.left >= parentRect.left && elementRect.right <= parentRect.right) return
      element.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      })
    }, ACTIVE_SCROLL_DELAY_MS)
  })

  onCleanup(() => {
    if (scrollTimer) clearTimeout(scrollTimer)
    if (selectTimer) clearTimeout(selectTimer)
  })

  const paintSelectedTab = (target: HTMLElement) => {
    const tab = target.closest('[data-testid="compact-switcher-tab"]')
    const nav = tab?.closest('[data-testid="compact-switcher"]')
    nav?.querySelectorAll('button[aria-current="page"]').forEach((button) => button.removeAttribute("aria-current"))
    tab?.querySelector<HTMLButtonElement>('[data-testid="switcher-title-button"]')?.setAttribute("aria-current", "page")
  }

  const cancelPendingSelect = () => {
    if (!selectTimer) return
    clearTimeout(selectTimer)
    selectTimer = undefined
  }

  const select = (event: MouseEvent, item: SwitcherItem) => {
    paintSelectedTab(event.currentTarget as HTMLElement)
    // Any explicit click supersedes a still-pending debounced selection — both
    // the immediate (active) path and a fresh debounce must drop the stale one,
    // otherwise the earlier scrub commits after this click and wins.
    cancelPendingSelect()
    if (item.active) {
      props.onSelect?.(item.contentId)
      return
    }
    selectTimer = setTimeout(() => {
      selectTimer = undefined
      props.onSelect?.(item.contentId)
    }, SWITCH_COMMIT_DELAY_MS)
  }

  const close = (event: Event, item: SwitcherItem) => {
    event.preventDefault()
    event.stopPropagation()
    // Closing the tab cancels any pending select for it — otherwise the debounced
    // selection fires ~48ms later and navigates to a surface being destroyed.
    cancelPendingSelect()
    props.onClose?.(item.contentId)
  }

  return (
    <nav
      aria-label="Workbench panes"
      data-testid="compact-switcher"
      class="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1"
      style={{
        "scrollbar-width": "none",
        "mask-image": "linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)",
        "-webkit-mask-image": "linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)",
      }}
    >
      <For each={items()}>
        {(item) => {
          return (
            <div
              data-testid="compact-switcher-tab"
              class="group relative h-7 min-w-[118px] max-w-[220px] shrink-0"
              ref={(el) => {
                itemElements.set(item.contentId, el)
              }}
            >
              <div
                class="flex h-7 w-full min-w-0 max-w-[220px] shrink-0 items-stretch gap-0 rounded-md border border-transparent py-0 pl-1.5 pr-1.5 text-left text-[12px] leading-none transition-[background-color,color] duration-100"
                classList={{
                  "bg-surface-base-hover text-text-base":
                    item.active,
                  "text-text-weak group-hover:bg-surface-base-hover/35 group-hover:text-text-base group-focus-within:bg-surface-base-hover/35 group-focus-within:text-text-base":
                    !item.active,
                  "pr-7": item.closable,
                }}
              >
                <Tooltip
                  value={<SwitcherMetadataCard item={item} />}
                  placement="bottom-start"
                  openDelay={240}
                  contentClass="z-[260] p-0 border-none bg-transparent shadow-none"
                  class="flex h-full w-5 shrink-0 items-center"
                >
                  <button
                    type="button"
                    aria-label={`${item.projectLabel ?? "Global"} / ${item.workspaceLabel ?? "Global"}`}
                    data-testid="switcher-prefix-trigger"
                    draggable={false}
                    class="flex h-full w-full shrink-0 items-center border-none bg-transparent p-0 outline-none"
                    onClick={(event) => select(event, item)}
                  >
                    <SwitcherPrefixMark item={item} active={item.active} />
                  </button>
                </Tooltip>
                <button
                  type="button"
                  aria-label={item.title}
                  data-testid="switcher-title-button"
                  aria-current={item.active ? "page" : undefined}
                  ref={(el) => {
                    // Pointer-driven surface drag (mouse + touch + pen), replacing
                    // native HTML5 `draggable` so tabs can be dragged onto a pane
                    // on touch devices too (WP-C3). `canDrag` still gates kind.
                    const dispose = useDragSource(el, {
                      contentId: () => (canDrag(item) ? item.contentId : undefined),
                      sourceKind: "tab",
                      label: () => item.title,
                      enabled: () => canDrag(item),
                      // Horizontal strip (`overflow-x-auto`): let the browser pan
                      // the tab row by touch; drag is gated behind a long-press.
                      touchAction: "pan-x",
                      onBegin: () => props.onDragStart?.(item.contentId),
                      onEnd: () => props.onDragEnd?.(),
                    })
                    onCleanup(dispose)
                  }}
                  onClick={(event) => select(event, item)}
                  onAuxClick={(event) => {
                    if (event.button !== 1 || !item.closable) return
                    close(event, item)
                  }}
                  class="ml-1 flex h-full min-w-0 flex-1 items-center border-none bg-transparent p-0 text-left text-[12px] leading-none text-inherit outline-none"
                >
                  <span
                    data-testid="switcher-title"
                    class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
                    style={{
                      "mask-image": "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
                      "-webkit-mask-image": "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
                    }}
                  >
                    {item.title}
                  </span>
                </button>
              </div>
              <Show when={item.closable}>
                <button
                  type="button"
                  aria-label={`Close ${item.title}`}
                  class="absolute right-1 top-1/2 z-10 flex size-[18px] -translate-y-1/2 items-center justify-center rounded border-none bg-transparent p-0 text-icon-weak-base opacity-0 outline-none transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-base hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-surface-base-hover group-hover:opacity-100"
                  classList={{
                    "opacity-65": item.active,
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => close(event, item)}
                >
                  <Icon name="close-small" size="small" />
                </button>
              </Show>
            </div>
          )
        }}
      </For>
    </nav>
  )
}
