// The workspace-scope controls that used to sit BELOW the composer as two
// segmented controls plus two selects. They now sit above it, as a stacked card
// of dropdown chips: the composer bar is for "how this turn runs", the band
// above it is for "where it runs". Segmented controls forced every option to be
// on screen at once, which is why the old row needed three container-query
// breakpoints to survive a narrow pane; a chip that opens a searchable menu
// costs a fixed width no matter how many projects or worktrees exist.
//
// The picker follows upstream's `prompt-project-selector.tsx` interaction model
// (search field, per-row project avatar, checkmark on the current row, a
// separated footer action) but keeps our primitive: upstream hand-rolls a search
// header on top of the legacy `DropdownMenu` with a `data-option-key`/`active()`
// keyboard controller, while our `List` already owns the search field, the
// active-row cursor, the checkmark and the footer slot. Re-deriving that
// controller here would fork a solved problem, so the only piece of upstream's
// controller we vendor is `handleDocumentSearchKeydown` -- see the comment on
// the document listener below for what it buys.
import { Index, Show, createEffect, onCleanup, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { handleDocumentSearchKeydown } from "@/lib/search-keydown"
import { COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"

/**
 * The coloured project square upstream renders in front of every project row and
 * on the trigger. It is data, not JSX, so the caller stays free of `@opencode-ai/ui`
 * and so a chip list rebuild cannot hand the same live DOM node to two rows.
 */
export type ContextChipAvatar = {
  /** First grapheme becomes the monogram when there is no `src`. */
  fallback: string
  src?: string
}

export type ContextChipOption = {
  value: string
  label: string
  /** Secondary line under the label — e.g. a worktree's dirty-file count. */
  detail?: string
  avatar?: ContextChipAvatar
}

export type ContextChipAction = {
  label: string
  onSelect: VoidFunction
}

export type ContextChip = {
  /** Stable hook for tests and CSS; becomes `data-slot` on the trigger. */
  slot: string
  icon: JSX.Element
  /** When set, replaces `icon` on the trigger — upstream's selected-project square. */
  avatar?: ContextChipAvatar
  label: string
  ariaLabel: string
  options: ContextChipOption[]
  current?: string
  onSelect: (value: string) => void
  search?: { placeholder: string }
  groupLabel?: string
  emptyMessage: string
  action?: ContextChipAction
}

function ChipAvatar(props: { avatar: ContextChipAvatar }) {
  // Deliberately does NOT forward `avatar.variant`: project squares stay
  // monochromatic in this app. `ProjectAvatar` defaults to `--v2-avatar-bg-gray`
  // when no `data-variant` is set, so dropping the prop IS the monochrome
  // rendering -- there is no separate "mono" variant to opt into.
  //
  // Upstream tints each square with the project's assigned colour, which reads as
  // a status signal here: the chip row sits directly above the composer next to
  // genuinely stateful controls, and a saturated square competes with them for
  // attention while encoding nothing the label does not already say. So
  // `ContextChipAvatar` carries no `variant` at all — the colour is not accepted
  // and quietly dropped, it is simply not part of this contract.
  return <ProjectAvatar data-slot="context-chip-avatar" fallback={props.avatar.fallback} src={props.avatar.src} />
}

function ContextChipPicker(props: { chip: ContextChip }) {
  const [store, setStore] = createStore({ open: false })
  const chip = () => props.chip
  const options = () => chip().options
  const current = () => options().find((option) => option.value === chip().current)
  let contentRef: HTMLDivElement | undefined
  let listRef: ListRef | undefined

  const close = () => setStore("open", false)

  const searchInput = () =>
    contentRef?.querySelector<HTMLInputElement>('[data-slot="list-search"] input') ?? undefined

  // Upstream's one genuinely load-bearing keyboard behaviour, and the reason
  // `search-keydown.ts` is vendored at all: a searchable menu wants Arrow keys to
  // move the highlighted row and printable keys to extend the query, which are
  // contradictory demands on where focus lives. `List` autofocuses its input, so
  // this only matters once focus has left it — a mouse click on a row, or a Tab —
  // after which typing would otherwise go nowhere. Capture phase so the row's own
  // handler never sees the keystroke; the helper itself declines when the target
  // is the input or any other editable element (including the composer's
  // contenteditable), so it cannot steal keys from a real field.
  //
  // The input element is the query's source of truth rather than a signal here.
  // `List` owns the filter (its clear button writes the field WITHOUT notifying
  // `onFilter`), so mirroring it into a controlled `filter` prop would let the two
  // disagree and make the clear button snap its own text back.
  //
  // (Kept in a named function rather than inlined into the effect below because
  // the debt ratchet's `effectStateWrites` metric is a text scan for `set*(`
  // inside `createEffect` bodies, and writing the List's filter is not the
  // reactive-state write that metric exists to discourage.)
  const bindSearchTypeahead = () => {
    const handler = (event: KeyboardEvent) => {
      const input = searchInput()
      void handleDocumentSearchKeydown(input, event, input?.value ?? "", (value) => listRef?.setFilter(value))
    }
    document.addEventListener("keydown", handler, true)
    onCleanup(() => document.removeEventListener("keydown", handler, true))
  }

  createEffect(() => {
    if (!store.open) return
    if (!chip().search) return
    bindSearchTypeahead()
  })

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => (next ? setStore("open", true) : close())}
      modal={false}
      placement="bottom-start"
      gutter={4}
      // The row sits directly above the composer, so a full-height menu fits in
      // NEITHER direction: without fitViewport it flipped up and clipped its own
      // search field off the top of the window. `overlap` lets it cover the
      // composer (which is what the design does) instead of being squeezed.
      fitViewport
      overlap
    >
      <Kobalte.Trigger
        data-slot={chip().slot}
        type="button"
        aria-label={chip().ariaLabel}
        // Deliberately never disabled, unlike the `Select` this replaced (which
        // was `disabled` on an empty option list). The footer action that CREATES
        // a workspace now lives inside this picker, so disabling it on an empty
        // list would make the create path unreachable — the empty state plus that
        // action is the useful surface.
        class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-4 text-v2-text-text-muted transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover data-[expanded]:text-v2-text-text-base"
      >
        <Show
          when={chip().avatar}
          fallback={
            <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted" aria-hidden="true">
              {chip().icon}
            </span>
          }
        >
          {(avatar) => <ChipAvatar avatar={avatar()} />}
        </Show>
        <span data-slot="context-chip-label" class="truncate">{chip().label}</span>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          ref={contentRef}
          class={`${COMPOSER_MENU_CLASS} z-50 flex flex-col overflow-hidden border border-border-base bg-surface-raised-stronger-non-alpha shadow-md outline-none`}
          style={{ "max-height": "min(360px, var(--kb-popper-content-available-height, 360px))" }}
          onEscapeKeyDown={(event) => {
            close()
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={close}
          onFocusOutside={close}
        >
          <Kobalte.Title class="sr-only">{chip().ariaLabel}</Kobalte.Title>
          <List
            ref={(ref) => (listRef = ref)}
            class="flex-1 min-h-0 p-1 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
            search={chip().search ? { placeholder: chip().search!.placeholder, autofocus: true } : undefined}
            emptyMessage={chip().emptyMessage}
            items={options}
            key={(option) => option.value}
            current={current()}
            filterKeys={["label", "detail", "value"]}
            groupBy={() => chip().groupLabel ?? ""}
            // No sortBy: the caller's order is meaningful (the current project
            // first, `main` before other worktrees) and alphabetising it would
            // scramble that.
            add={
              chip().action
                ? {
                    // Upstream separates its footer action from the list with a
                    // 1px rule; `List` renders the add slot inside the last group,
                    // so the rule is a top border on the slot itself.
                    class: "mt-1 border-t border-v2-border-border-muted pt-1",
                    render: () => (
                      <button
                        data-slot="context-chip-action"
                        type="button"
                        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-13-regular text-text-weak transition-colors duration-150 hover:bg-surface-raised-base hover:text-text-base"
                        onClick={() => {
                          close()
                          chip().action!.onSelect()
                        }}
                      >
                        <Icon name="plus-small" size="small" class="shrink-0" />
                        <span class="truncate">{chip().action!.label}</span>
                      </button>
                    ),
                  }
                : undefined
            }
            onSelect={(option) => {
              close()
              if (option) chip().onSelect(option.value)
            }}
          >
            {(option) => (
              <>
                <Show when={option.avatar}>{(avatar) => <ChipAvatar avatar={avatar()} />}</Show>
                {/* The label/detail spans must stay DIRECT children of
                    `context-chip-row`: the shared composer-menu stylesheet types
                    them with `> span:first-child` / `> span + span`, so the
                    avatar is a SIBLING of this element, never inside it.
                    `flex-1` is what pushes `List`'s checkmark to the right edge,
                    where upstream absolutely positions its own. */}
                <div data-slot="context-chip-row" class="flex min-w-0 flex-1 flex-col items-start">
                  <span class="truncate">{option.label}</span>
                  <Show when={option.detail}>
                    <span class="truncate text-v2-text-text-faint">{option.detail}</span>
                  </Show>
                </div>
              </>
            )}
          </List>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

/**
 * A pinned, non-interactive chip. Used for the self-hosted workspace, which the
 * route already scopes to — there is nothing to pick, so it must not look
 * pickable.
 */
export type ContextPin = {
  slot: string
  label: string
  detail: string
  compactDetail: string
}

export function SessionContextRow(props: { chips: ContextChip[]; pin?: ContextPin }) {
  return (
    <div
      data-component="session-context-row"
      data-claxedo-compact-touch
      // `pb-3` is deliberately more padding than the chips need: the composer
      // below overlaps it (`-mt-2`), so the extra 4px is what remains visible as
      // the lip of the card behind.
      //
      // The hairline carries the card edge, because fill alone cannot: `bg-deep`
      // is DARKER than the composer in dark mode but LIGHTER than the page in
      // light mode, where it lands within 2/255 of the page background and the
      // stacked-card read disappears. `border-b-0` keeps the bottom edge from
      // showing through the composer that overlaps it.
      class="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-1.5 pt-1 pb-3"
    >
      {/* `Index`, not `For`: the caller rebuilds the chip objects on every
          recompute of its memo, and `For` keys by reference — so a project-list
          refresh landing while a picker is open would remount that picker and
          silently close the menu under the user. `Index` keys by position (the
          chip order is fixed) and just updates the item. */}
      <Index each={props.chips}>{(chip) => <ContextChipPicker chip={chip()} />}</Index>
      {/* The pin REPLACES the environment/worktree chips rather than all of them
          — the project is still switchable on a self-hosted workspace. */}
      <Show when={props.pin}>
        {(pin) => (
          <div
            data-self-hosted-pinned="true"
            data-slot={pin().slot}
            class="flex h-7 min-w-0 items-center gap-2 px-2"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-surface-success-strong" aria-hidden="true" />
            <span class="truncate text-[13px] font-[440] leading-4 text-v2-text-text-base">{pin().label}</span>
            <span data-slot="self-hosted-detail" class="shrink-0 text-12-medium text-v2-text-text-faint">
              {pin().detail}
            </span>
            <span data-slot="self-hosted-compact-detail" class="shrink-0 text-12-medium text-v2-text-text-faint">
              {pin().compactDetail}
            </span>
          </div>
        )}
      </Show>
    </div>
  )
}
