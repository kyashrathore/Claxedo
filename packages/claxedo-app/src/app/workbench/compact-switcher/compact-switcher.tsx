import { For, Show, createEffect, onCleanup } from "solid-js"
import type { SwitcherItem } from "./switcher-items"
import { useDragSource } from "../workbench/index"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"

const ACTIVE_SCROLL_DELAY_MS = 120
const SWITCH_COMMIT_DELAY_MS = 48

export type CompactSwitcherProps = {
  items?: SwitcherItem[]
  onSelect?: (contentId: string) => void
  onClose?: (contentId: string) => void
  onDragStart?: (contentId: string) => void
  onDragEnd?: () => void
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
      class="relative flex h-full w-5 shrink-0 items-center justify-center text-text-weaker transition-opacity duration-100"
      classList={{
        "opacity-55 group-hover:opacity-100 group-focus-within:opacity-100": !props.active,
        "opacity-100": props.active,
      }}
    >
      <ProjectAvatar
        data-switcher-project-avatar
        fallback={fallback(props.item.projectLabel, "Global")}
        variant="outline"
        class="size-4 shrink-0"
      />
      <Show when={hasVisibleStatus(props.item)}>
        <span class="absolute bottom-[3px] right-0 flex rounded-full bg-background-base p-px">
          <StatusDot status={props.item.status} />
        </span>
      </Show>
    </span>
  )
}

function MetadataRow(props: { icon: ClaxedoIconProps["name"]; label: string; value?: string }) {
  const value = () => props.value?.trim()
  return (
    <div class="grid min-h-[20px] grid-cols-[16px_64px_minmax(0,1fr)] items-center gap-x-2.5">
      {/*
        No chip behind the glyph. Five filled squares stacked down a 320px card
        were the loudest thing in it, and they encode what the label beside them
        already says — the icon is here to help the eye find a row, not to be a
        second label.
      */}
      <span class="flex items-center justify-center text-icon-weak-base">
        <Icon name={props.icon} size="small" />
      </span>
      {/*
        Sentence case, not tracked micro-caps. At 10px with 0.08em tracking
        "WORKSPACE" only just cleared its 76px column — one longer word, or any
        of the other fifteen locales, and it truncated. Sentence case at 11px is
        narrower, quieter, and leaves the value as the thing being read.
      */}
      <span class="text-[11px] text-text-weaker">{props.label}</span>
      <span
        class="min-w-0 truncate text-[12px]"
        classList={{
          "text-text-base": !!value(),
          // Absence is not a value. An em dash says "nothing here" without
          // spending a full phrase on it, twice, in a five-row card.
          "text-text-weaker": !value(),
        }}
        title={value() || undefined}
      >
        {value() || "—"}
      </span>
    </div>
  )
}

function SwitcherMetadataCard(props: { item: SwitcherItem }) {
  return (
    <div
      data-slot="switcher-metadata-card"
      // This card floats above content, so it takes the overlay surface and the
      // same elevation as the composer menus and dropdowns.
      // `bg-v2-background-bg-layer-01` is a PAGE layer — it is what made this
      // card read grey against the white menus beside it. The elevation token
      // carries its own 0.5px ring, so the border goes with it.
      // `raised`, not `floating`: one step down the same elevation scale. This
      // is a hover card the size of a tooltip, and the floating step is what the
      // composer menus use — it read as a heavier object than it is.
      class="w-[320px] rounded-lg bg-[var(--overlay-surface)] p-3 shadow-[var(--v2-elevation-raised)]"
    >
      <div class="mb-2.5 flex items-center gap-2.5">
        <ProjectAvatar
          fallback={fallback(props.item.projectLabel, "Global")}
          variant="outline"
          class="size-8 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-semibold leading-tight text-text-base">
            {fallback(props.item.title, "Untitled session")}
          </div>
          <div class="mt-1 truncate text-[11px] leading-tight text-text-weaker">
            {fallback(props.item.projectLabel, "Global")} · {fallback(props.item.workspaceLabel, "Global")}
          </div>
        </div>
      </div>

      {/*
        `gap-y-0.5` on 20px rows, not `space-y-2`. The rows are a scan target,
        so an even, tight rhythm reads as one block; 8px gaps made five short
        rows look like five separate things.
      */}
      <div class="grid gap-y-0.5">
        <MetadataRow icon="folder" label="Project" value={fallback(props.item.projectLabel, "Global")} />
        <MetadataRow icon="link" label="Git repo" value={props.item.gitRepo} />
        <MetadataRow icon="branch" label="Branch" value={props.item.gitBranch} />
        <MetadataRow icon="file-tree" label="Worktree" value={props.item.workspaceDir ?? props.item.projectWorktree} />
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
                data-slot="workbench-tab"
                data-selected={item.active ? "true" : undefined}
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
                  class="absolute right-1 top-1/2 z-10 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full border-none bg-transparent p-0 text-icon-weak-base opacity-0 outline-none transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-base hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-surface-base-hover group-hover:opacity-100"
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
