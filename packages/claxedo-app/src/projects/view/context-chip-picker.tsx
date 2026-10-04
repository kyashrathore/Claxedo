import { createEffect, createMemo, onCleanup, Show, untrack, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { createStore } from "solid-js/store"
import { Icon, List, type ListRef, ProjectAvatar } from "@/ui"
import { COMPOSER_MENU_CLASS } from "@/composer"
import { handleDocumentSearchKeydown } from "../search-keydown"
import type { ContextChip, ContextChipAvatar, ContextChipOption } from "./context-row"

const FOOTER_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-13-regular text-text-weak transition-colors duration-150 hover:bg-[var(--overlay-surface-hover)] hover:text-text-base"

function ChipAvatar(props: { avatar: ContextChipAvatar }) {
  return <ProjectAvatar class="context-chip-avatar" fallback={props.avatar.fallback} src={props.avatar.src} variant="outline" />
}

function ChipTrigger(props: { chip: ContextChip }) {
  return (
    <Kobalte.Trigger
      data-chip={props.chip.slot}
      type="button"
      aria-label={props.chip.ariaLabel}
      title={props.chip.title}
      disabled={props.chip.disabled}
      class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-compact font-body leading-4 text-v2-text-text-muted transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover data-[expanded]:text-v2-text-text-base"
    >
      <Show
        when={props.chip.avatar}
        fallback={
          <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted" aria-hidden="true">
            {props.chip.icon}
          </span>
        }
      >
        {(avatar) => <ChipAvatar avatar={avatar()} />}
      </Show>
      <span class="ui-context-chip-label truncate">
        {props.chip.label}
      </span>
    </Kobalte.Trigger>
  )
}

function ChipOptionRow(props: { option: ContextChipOption }) {
  return (
    <>
      <Show when={props.option.avatar}>{(avatar) => <ChipAvatar avatar={avatar()} />}</Show>
      <div class="context-chip-row flex min-w-0 flex-1 flex-col items-start">
        <span class="truncate">{props.option.label}</span>
        <Show when={props.option.detail}>
          <span class="truncate text-v2-text-text-faint">{props.option.detail}</span>
        </Show>
      </div>
    </>
  )
}

function ChipFooter(props: { label: string; onClick: () => void }) {
  return (
    <div class="mt-1 shrink-0 border-t border-v2-border-border-muted p-1 pt-1">
      <button type="button" class={FOOTER_ROW} onClick={() => props.onClick()}>
        <Icon name="plus-small" size="small" class="shrink-0" />
        <span class="truncate">{props.label}</span>
      </button>
    </div>
  )
}

function ChipList(props: { chip: ContextChip; ref: (ref: ListRef) => void; close: () => void; openPanel: () => void }) {
  const current = () => props.chip.options.find((option) => option.value === props.chip.current)
  return (
    <>
      <List
        ref={props.ref}
        class="flex-1 min-h-0 p-1 [&_.ui-list-scroll]:flex-1 [&_.ui-list-scroll]:min-h-0"
        search={props.chip.search ? { placeholder: props.chip.search.placeholder, autofocus: true } : undefined}
        emptyMessage={props.chip.emptyMessage}
        items={() => props.chip.options}
        key={(option) => option.value}
        current={current()}
        filterKeys={["label", "detail", "value"]}
        groupBy={(option) => option.group ?? props.chip.groupLabel ?? ""}
        onSelect={(option) => {
          props.close()
          if (option) props.chip.onSelect(option.value)
        }}
      >
        {(option) => <ChipOptionRow option={option} />}
      </List>
      <Show when={props.chip.action}>
        {(action) => (
          <ChipFooter
            label={action().label}
            onClick={() => {
              props.close()
              action().onSelect()
            }}
          />
        )}
      </Show>
      <Show when={props.chip.panel}>{(panel) => <ChipFooter label={panel().label} onClick={props.openPanel} />}</Show>
    </>
  )
}

function bindSearchTypeahead(input: () => HTMLInputElement | undefined, setFilter: (value: string) => void) {
  const handler = (event: KeyboardEvent) => {
    const field = input()
    void handleDocumentSearchKeydown(field, event, field?.value ?? "", setFilter)
  }
  document.addEventListener("keydown", handler, true)
  onCleanup(() => document.removeEventListener("keydown", handler, true))
}

function createPickerState() {
  const [store, setStore] = createStore({ open: false, panel: false, hold: false })
  const close = () => {
    setStore({ open: false, panel: false, hold: false })
  }
  const back = () => {
    setStore({ open: true, panel: false })
  }
  return {
    store,
    setStore,
    close,
    back,
    isOpen: () => store.open,
    panelShown: () => store.panel,
  }
}

export function ContextChipPicker(props: { chip: ContextChip }): JSX.Element {
  const chip = () => props.chip
  const state = createPickerState()
  let contentRef: HTMLDivElement | undefined
  let listRef: ListRef | undefined
  const showPanel = createMemo(() => state.panelShown() && !!chip().panel)
  const panelContent = createMemo(() => {
    if (!showPanel()) return undefined
    return untrack(() => chip().panel?.render({ close: state.close, back: state.back, hold: (active) => state.setStore("hold", active) }))
  })
  const searchInput = () => contentRef?.querySelector<HTMLInputElement>(".ui-list-search-wrapper input") ?? undefined
  createEffect(() => {
    if (!state.isOpen() || !chip().search) return
    bindSearchTypeahead(searchInput, (value) => listRef?.setFilter(value))
  })
  return (
    <Kobalte
      open={state.isOpen()}
      onOpenChange={(next) => (next ? state.setStore("open", true) : state.close())}
      modal={false}
      placement="bottom-start"
      gutter={4}
      fitViewport
      overlap
    >
      <ChipTrigger chip={chip()} />
      <Kobalte.Portal>
        <Kobalte.Content
          ref={contentRef}
          data-context-chip-picker={chip().slot}
          class={`${COMPOSER_MENU_CLASS} z-50 flex flex-col overflow-hidden outline-none`}
          style={{ "max-height": "min(360px, var(--kb-popper-content-available-height, 360px))", background: "var(--overlay-surface)" }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (!state.store.hold) state.close()
          }}
          onPointerDownOutside={(event) => (state.store.hold ? event.preventDefault() : state.close())}
          onFocusOutside={(event) => (state.store.hold ? event.preventDefault() : state.close())}
        >
          <Kobalte.Title class="sr-only">{chip().ariaLabel}</Kobalte.Title>
          <Show when={panelContent()}>
            {(content) => (
              <div class="flex min-h-0 flex-col p-2">
                {content()}
              </div>
            )}
          </Show>
          <Show when={!state.panelShown()}>
            <ChipList chip={chip()} ref={(ref) => (listRef = ref)} close={state.close} openPanel={() => state.setStore("panel", true)} />
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
