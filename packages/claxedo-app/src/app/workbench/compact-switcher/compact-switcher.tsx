import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import type { SwitcherItem } from "./switcher-items"
import { useDragSource } from "../workbench/index"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { NUMBERED_SURFACE_SHORTCUTS } from "../rail/rail-keyboard-shortcuts"

const ACTIVE_SCROLL_DELAY_MS = 120
const SWITCH_COMMIT_DELAY_MS = 48
const COMMAND_HINT_HOLD_MS = 500

export type CompactSwitcherProps = {
  items?: SwitcherItem[]
  onSelect?: (contentId: string) => void
  onClose?: (contentId: string) => void
  onDragStart?: (contentId: string) => void
  onDragEnd?: () => void
  shortcutHints?: readonly string[]
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
      <span class="text-xs text-text-weaker">{props.label}</span>
      <span
        class="min-w-0 truncate text-sm"
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
      // `raised`, one step below the `floating` the composer menus carry — this
      // is a hover card the size of a tooltip. The token's own 0.5px ring stays:
      // themes that edge their surfaces should edge this one too. Codex assigns
      // its own half-pixel card ring and quieter washes through the generic
      // surface role in ui-overrides.css.
      class="w-[320px] bg-[var(--overlay-surface)] p-3"
    >
      <div class="mb-2.5 flex items-center gap-2.5">
        <ProjectAvatar
          fallback={fallback(props.item.projectLabel, "Global")}
          variant="outline"
          class="size-8 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-compact font-semibold leading-tight text-text-base">
            {fallback(props.item.title, "Untitled session")}
          </div>
          <div class="mt-1 truncate text-xs leading-tight text-text-weaker">
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
  let stripElement: HTMLElement | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let selectTimer: ReturnType<typeof setTimeout> | undefined
  let commandHintTimer: ReturnType<typeof setTimeout> | undefined
  const items = () => props.items ?? []
  const shortcutHints = () => props.shortcutHints ?? NUMBERED_SURFACE_SHORTCUTS.map((shortcut) => `⌘${shortcut.number}`)
  const activeItem = () => items().find((item) => item.active)

  // The strip is rendered from CONTENT IDS, not from the item objects. The
  // caller's `switcherItems` memo rebuilds every SwitcherItem object on every
  // recompute (focus change, status tick, worktree-info resolve), and `<For>`
  // keys on object identity — so keying on the objects tore down and rebuilt
  // the whole row each time, throwing away the strip's horizontal scroll
  // position and making a plain tab click jump. Ids are primitives, so an
  // unchanged id keeps its DOM node and every field below updates in place.
  const itemIds = createMemo(() => items().map((item) => item.contentId))
  const itemById = createMemo(() => new Map(items().map((item) => [item.contentId, item] as const)))

  createEffect(() => {
    const ids = new Set(itemIds())
    itemElements.forEach((_, id) => {
      if (!ids.has(id)) itemElements.delete(id)
    })
  })

  createEffect(() => {
    const item = activeItem()
    if (!item) return
    const element = itemElements.get(item.contentId)
    const parent = stripElement
    if (!element || !parent) return
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const elementRect = element.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const leftOverflow = elementRect.left - parentRect.left
      const rightOverflow = elementRect.right - parentRect.right
      if (leftOverflow >= 0 && rightOverflow <= 0) return
      // Move the strip itself rather than calling `scrollIntoView`, which walks
      // EVERY scrollable ancestor — a tab at the header edge could otherwise
      // scroll the workbench beneath it. `smooth` so the catch-up reads as the
      // strip following the selection instead of a snap.
      const left = parent.scrollLeft + (leftOverflow < 0 ? leftOverflow : rightOverflow)
      if (typeof parent.scrollTo === "function") parent.scrollTo({ left, behavior: "smooth" })
      else parent.scrollLeft = left
    }, ACTIVE_SCROLL_DELAY_MS)
  })

  const hideCommandHints = () => {
    if (commandHintTimer) clearTimeout(commandHintTimer)
    commandHintTimer = undefined
    stripElement?.removeAttribute("data-command-hints")
  }

  const handleCommandKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Meta" || commandHintTimer || stripElement?.hasAttribute("data-command-hints")) return
    commandHintTimer = setTimeout(() => {
      commandHintTimer = undefined
      stripElement?.setAttribute("data-command-hints", "true")
    }, COMMAND_HINT_HOLD_MS)
  }

  const handleCommandKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Meta") hideCommandHints()
  }

  onMount(() => {
    window.addEventListener("keydown", handleCommandKeyDown)
    window.addEventListener("keyup", handleCommandKeyUp)
    window.addEventListener("blur", hideCommandHints)
    onCleanup(() => {
      window.removeEventListener("keydown", handleCommandKeyDown)
      window.removeEventListener("keyup", handleCommandKeyUp)
      window.removeEventListener("blur", hideCommandHints)
    })
  })

  onCleanup(() => {
    if (scrollTimer) clearTimeout(scrollTimer)
    if (selectTimer) clearTimeout(selectTimer)
    if (commandHintTimer) clearTimeout(commandHintTimer)
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
      ref={(el) => {
        stripElement = el
      }}
      aria-label="Workbench panes"
      data-testid="compact-switcher"
      class="group/switcher flex h-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1"
      style={{
        "scrollbar-width": "none",
      }}
    >
      <For each={itemIds()}>
        {(id, index) => (
          <Show when={itemById().get(id)}>
            {(item) => (
              <div
                data-testid="compact-switcher-tab"
                // The 28px tab IS the tap target — it is 118-220px wide, which
                // clears a thumb horizontally. Without this opt-out the mobile /
                // coarse-pointer floor in app-shell.css sizes every button
                // inside it to 40x40: the title button outgrows the tab and
                // drops its label ~7px below the avatar, and the 18px close
                // glyph inflates over the title. Same reasoning as the rail
                // sidebar rows.
                data-claxedo-compact-touch
                class="group relative h-7 min-w-[118px] max-w-[220px] shrink-0"
                ref={(el) => {
                  itemElements.set(id, el)
                }}
              >
                <div
                  data-slot="workbench-tab"
                  data-selected={item().active ? "true" : undefined}
                  class="flex h-7 w-full min-w-0 max-w-[220px] shrink-0 items-stretch gap-0 rounded-md border border-transparent py-0 pl-1.5 pr-1.5 text-left text-sm leading-none transition-[background-color,color] duration-100"
                  classList={{
                    "bg-surface-base-hover text-text-base":
                      item().active,
                    "text-text-weak group-hover:bg-surface-base-hover/35 group-hover:text-text-base group-focus-within:bg-surface-base-hover/35 group-focus-within:text-text-base":
                      !item().active,
                    "pr-7": item().closable,
                  }}
                >
                  <Tooltip
                    value={<SwitcherMetadataCard item={item()} />}
                    placement="bottom-start"
                    openDelay={240}
                    // `theme-overlay-bare`: this tooltip is a POSITIONER, not a
                    // surface — the card inside draws the chrome. Codex gives every
                    // overlay a hairline with `!important`, which beats the
                    // `shadow-none` utility here and edged the wrapper as well as
                    // the card, a pixel apart. The marker opts it out.
                    contentClass="theme-overlay-bare z-[260] p-0 border-none bg-transparent shadow-none"
                    class="flex h-full w-5 shrink-0 items-center"
                  >
                    <button
                      type="button"
                      aria-label={`${item().projectLabel ?? "Global"} / ${item().workspaceLabel ?? "Global"}`}
                      data-testid="switcher-prefix-trigger"
                      draggable={false}
                      class="relative flex h-full w-full shrink-0 items-center border-none bg-transparent p-0 outline-none"
                      onClick={(event) => select(event, item())}
                    >
                      <SwitcherPrefixMark
                        item={item()}
                        active={item().active}
                      />
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    aria-label={item().title}
                    data-testid="switcher-title-button"
                    aria-current={item().active ? "page" : undefined}
                    ref={(el) => {
                      // Pointer-driven surface drag (mouse + touch + pen), replacing
                      // native HTML5 `draggable` so tabs can be dragged onto a pane
                      // on touch devices too (WP-C3). `canDrag` still gates kind.
                      const dispose = useDragSource(el, {
                        contentId: () => (canDrag(item()) ? item().contentId : undefined),
                        sourceKind: "tab",
                        label: () => item().title,
                        enabled: () => canDrag(item()),
                        // Horizontal strip (`overflow-x-auto`): let the browser pan
                        // the tab row by touch; drag is gated behind a long-press.
                        touchAction: "pan-x",
                        onBegin: () => props.onDragStart?.(item().contentId),
                        onEnd: () => props.onDragEnd?.(),
                      })
                      onCleanup(dispose)
                    }}
                    onClick={(event) => select(event, item())}
                    onAuxClick={(event) => {
                      if (event.button !== 1 || !item().closable) return
                      close(event, item())
                    }}
                    class="ml-1 flex h-full min-w-0 flex-1 items-center border-none bg-transparent p-0 text-left text-sm leading-none text-inherit outline-none"
                  >
                    {/* Ellipsis, not a fade mask. The tab caps at 220px, and a
                        gradient that dissolves the last 16px reads as a render
                        glitch at that width — the reader cannot tell a clipped
                        title from a faint one. `truncate` ends it on a glyph. */}
                    <span data-testid="switcher-title" class="min-w-0 flex-1 truncate">
                      {item().title}
                    </span>
                  </button>
                </div>
                <Show when={item().closable}>
                  <button
                    type="button"
                    aria-label={`Close ${item().title}`}
                    /* `rounded-sm`, matching `--radius-sm` in icon-button.css —
                       the hover chip behind a dismiss X is the same shape here
                       as on every other icon button, not a circle. */
                    class="absolute right-1 top-1/2 z-10 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-sm border-none bg-transparent p-0 text-icon-weak-base opacity-0 outline-none transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-base hover:opacity-100 focus-visible:opacity-100 focus-visible:bg-surface-base-hover group-hover:opacity-100"
                    classList={{
                      "opacity-65": item().active,
                      "group-data-[command-hints]/switcher:hidden": !!shortcutHints()[index()],
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => close(event, item())}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </Show>
                <Show when={shortcutHints()[index()]} keyed>
                  {(hint) => (
                    <span
                      aria-hidden="true"
                      data-testid="switcher-command-hint"
                      class="absolute right-1 top-1/2 z-20 hidden h-5 min-w-7 -translate-y-1/2 items-center justify-center rounded-md bg-surface-base-hover px-1.5 text-11-medium text-text-weak group-data-[command-hints]/switcher:flex"
                    >
                      {hint}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
    </nav>
  )
}
