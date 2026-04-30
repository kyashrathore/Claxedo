import { For, Show, createEffect } from "solid-js"
import { itemNeedsAttention, type SwitcherGroup, type SwitcherItem } from "./switcher-items"
import { WORKBENCH_DRAG_MIME } from "../layout"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"

export type CompactSwitcherProps = {
  items?: SwitcherItem[]
  groups?: SwitcherGroup[]
  onSelect?: (contentId: string) => void
  onDragStart?: (contentId: string) => void
  onDragEnd?: () => void
}

const GROUP_TINTS = [
  "light-dark(rgba(92, 64, 18, 0.045), rgba(237, 224, 206, 0.032))",
  "light-dark(rgba(38, 64, 38, 0.045), rgba(178, 184, 174, 0.032))",
  "light-dark(rgba(72, 40, 96, 0.045), rgba(191, 174, 207, 0.032))",
  "light-dark(rgba(24, 62, 92, 0.045), rgba(166, 188, 205, 0.032))",
  "light-dark(rgba(88, 72, 32, 0.045), rgba(246, 240, 226, 0.032))",
]

function StatusDot(props: { status?: SwitcherItem["status"] }) {
  const bg = () => {
    if (props.status === "working") return "var(--surface-warning-strong)"
    if (props.status === "permission") return "var(--surface-critical-strong)"
    if (props.status === "done") return "var(--surface-success-strong)"
    return undefined
  }

  return (
    <Show when={bg()}>
      <span
        aria-hidden="true"
        data-switcher-status={props.status}
        class="mr-1.5 inline-flex size-1.5 shrink-0 rounded-full"
        style={{ "background-color": bg() }}
      />
    </Show>
  )
}

export function CompactSwitcher(props: CompactSwitcherProps) {
  const itemElements = new Map<string, HTMLDivElement>()
  const groups = () =>
    props.groups ?? [
      {
        id: "default",
        label: "",
        items: props.items ?? [],
        hiddenItems: [],
        hiddenCount: 0,
        hiddenAttentionCount: 0,
      },
    ]

  const groupTint = (index: number) => GROUP_TINTS[index % GROUP_TINTS.length]
  const activeItem = () => groups().flatMap((group) => group.items).find((item) => item.active)
  const hiddenMenuItems = (group: SwitcherGroup) => [
    ...group.hiddenItems.filter(itemNeedsAttention),
    ...group.hiddenItems.filter((item) => !itemNeedsAttention(item)),
  ]

  createEffect(() => {
    const item = activeItem()
    if (!item) return
    const element = itemElements.get(item.contentId)
    if (!element?.scrollIntoView) return
    element.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  })

  return (
    <nav
      aria-label="Workbench panes"
      data-testid="compact-switcher"
      class="flex h-full min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
      style={{ "scrollbar-width": "none" }}
    >
      <For each={groups()}>
        {(group, index) => (
          <div
            class="flex h-8 shrink-0 items-center gap-0.5 rounded-lg p-0.5"
            data-testid="compact-switcher-group"
            title={[group.label, group.projectLabel].filter(Boolean).join(" · ")}
            style={{ "background-color": groupTint(index()) }}
          >
            <For each={group.items}>
              {(item) => (
                <div
                  role="button"
                  tabIndex={0}
                  aria-current={item.active ? "page" : undefined}
                  title={item.title}
                  ref={(el) => {
                    itemElements.set(item.contentId, el)
                    el.setAttribute("draggable", item.kind === "session" || item.kind === "terminal" ? "true" : "false")
                  }}
                  onClick={() => props.onSelect?.(item.contentId)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    props.onSelect?.(item.contentId)
                  }}
                  onDragStart={(event) => {
                    if (item.kind !== "session" && item.kind !== "terminal") return
                    event.dataTransfer?.setData(WORKBENCH_DRAG_MIME, item.contentId)
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                    props.onDragStart?.(item.contentId)
                  }}
                  onDragEnd={() => props.onDragEnd?.()}
                  class="flex h-7 max-w-[240px] shrink-0 items-center rounded-md px-2 text-left text-[12px] leading-none outline-none"
                  style={{
                    "transition-property": "background-color, color",
                    "transition-duration": "120ms",
                    "transition-timing-function": "cubic-bezier(0.2, 0, 0, 1)",
                  }}
                  classList={{
                    "bg-surface-base-hover/80 text-text-base": item.active,
                    "text-text-weak hover:bg-surface-base-hover/40 hover:text-text-base":
                      !item.active,
                  }}
                >
                  <StatusDot status={item.status} />
                  <span class="truncate">{item.title}</span>
                </div>
              )}
            </For>
            <Show when={group.hiddenCount > 0}>
              <DropdownMenu>
                <DropdownMenu.Trigger
                  aria-label={`${group.hiddenCount} more ${group.label || "workspace"} surfaces`}
                  class="relative flex h-6 shrink-0 items-center rounded-md border-none bg-transparent px-1.5 text-[11px] leading-none text-text-weak/60 outline-none transition-colors hover:bg-surface-base-hover/40 hover:text-text-base focus-visible:bg-surface-base-hover/40 focus-visible:text-text-base"
                  style={{ "font-variant-numeric": "tabular-nums" }}
                >
                  +{group.hiddenCount}
                  <Show when={group.hiddenAttentionCount > 0}>
                    <span
                      aria-hidden="true"
                      data-testid="compact-switcher-hidden-attention"
                      class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-surface-critical-strong"
                    />
                  </Show>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="z-[220] min-w-[220px]">
                    <For each={hiddenMenuItems(group)}>
                      {(item) => (
                        <DropdownMenu.Item onSelect={() => props.onSelect?.(item.contentId)}>
                          <StatusDot status={item.status} />
                          <span class="min-w-0 flex-1 truncate">{item.title}</span>
                        </DropdownMenu.Item>
                      )}
                    </For>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </Show>
          </div>
        )}
      </For>
    </nav>
  )
}
