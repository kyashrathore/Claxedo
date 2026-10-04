import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Icon, List, type ListRef, ProjectAvatar } from "@/ui"
import { COMPOSER_MENU_CLASS } from "@/composer"
import { handleDocumentSearchKeydown } from "../search-keydown"
import type { ContextChip, ContextChipAction, ContextChipAvatar, ContextChipOption } from "./context-row"

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

function ChipFooter(props: { actions: readonly ContextChipAction[]; divided: boolean; close: () => void }) {
  return (
    <div class="shrink-0 p-1" classList={{ "mt-1 border-t border-v2-border-border-muted": props.divided }}>
      <For each={props.actions}>
        {(action) => (
          <button
            type="button"
            class={FOOTER_ROW}
            onClick={() => {
              props.close()
              action.onSelect()
            }}
          >
            <Icon name="plus-small" size="small" class="shrink-0" />
            <span class="truncate">{action.label}</span>
          </button>
        )}
      </For>
    </div>
  )
}

function ChipList(props: { chip: ContextChip; ref: (ref: ListRef) => void; close: () => void }) {
  const current = () => props.chip.options.find((option) => option.value === props.chip.current)
  return (
    <>
      <Show when={props.chip.options.length > 0 || !props.chip.actions?.length}>
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
      </Show>
      <Show when={props.chip.actions?.length ? props.chip.actions : undefined}>
        {(actions) => <ChipFooter actions={actions()} divided={props.chip.options.length > 0} close={props.close} />}
      </Show>
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

export function ContextChipPicker(props: { chip: ContextChip }): JSX.Element {
  const chip = () => props.chip
  const [open, setOpen] = createSignal(false)
  const close = () => setOpen(false)
  let contentRef: HTMLDivElement | undefined
  let listRef: ListRef | undefined
  const searchInput = () => contentRef?.querySelector<HTMLInputElement>(".ui-list-search-wrapper input") ?? undefined
  createEffect(() => {
    if (!open() || !chip().search) return
    bindSearchTypeahead(searchInput, (value) => listRef?.setFilter(value))
  })
  return (
    <Kobalte open={open()} onOpenChange={setOpen} modal={false} placement="bottom-start" gutter={4} fitViewport overlap>
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
            close()
          }}
        >
          <Kobalte.Title class="sr-only">{chip().ariaLabel}</Kobalte.Title>
          <ChipList chip={chip()} ref={(ref) => (listRef = ref)} close={close} />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
