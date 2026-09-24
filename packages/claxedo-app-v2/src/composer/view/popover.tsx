import { For, Match, Show, Switch } from "solid-js"
import { FileIcon, Icon, Loader } from "@/ui"
import type { AtItem, SlashItem } from "../suggestions"
import type { ComposerSetup } from "../setup"
import { COMPOSER_LISTBOX_ID, composerOptionId } from "./editor"

function pathParts(path: string) {
  const directory = path.endsWith("/")
  const trimmed = directory ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf("/")
  return { directory, folder: index >= 0 ? trimmed.slice(0, index + 1) : "", name: index >= 0 ? trimmed.slice(index + 1) : trimmed }
}

function AtOption(props: { item: AtItem; active: boolean; onSelect: () => void; onHover: () => void }) {
  const parts = () => (props.item.kind === "file" ? pathParts(props.item.path) : undefined)
  return (
    <button
      type="button"
      role="option"
      id={composerOptionId(props.item.id)}
      aria-selected={props.active}
      data-slot="composer-option"
      data-kind={props.item.kind}
      onClick={props.onSelect}
      onMouseEnter={props.onHover}
    >
      <Switch>
        <Match when={props.item.kind === "file" && parts()}>
          {(file) => (
            <>
              <FileIcon node={{ path: props.item.kind === "file" ? props.item.path : "", type: file().directory ? "directory" : "file" }} class="shrink-0" />
              <span data-slot="composer-option-text">
                <span data-slot="composer-option-muted">{file().folder}</span>
                <span>{file().name}</span>
              </span>
            </>
          )}
        </Match>
        <Match when={props.item.kind === "mention" && props.item}>
          {(item) => (
            <>
              <Icon name="prompt" size="small" class="shrink-0" />
              <span data-slot="composer-option-text">
                <span>{item().entry.label}</span>
                <span data-slot="composer-option-muted">{item().entry.group}</span>
              </span>
            </>
          )}
        </Match>
      </Switch>
    </button>
  )
}

function SlashOption(props: { item: SlashItem; active: boolean; onSelect: () => void; onHover: () => void }) {
  return (
    <button
      type="button"
      role="option"
      id={composerOptionId(props.item.id)}
      aria-selected={props.active}
      data-slot="composer-option"
      data-kind={props.item.kind}
      onClick={props.onSelect}
      onMouseEnter={props.onHover}
    >
      <span data-slot="composer-option-text">
        <span>/{props.item.trigger}</span>
        <span data-slot="composer-option-muted">{props.item.title}</span>
      </span>
      <Show when={props.item.kind === "command" && props.item.keybinding}>
        {(keybinding) => <span data-slot="composer-option-keybind">{keybinding()}</span>}
      </Show>
    </button>
  )
}

export function ComposerPopover(props: { composer: ComposerSetup }) {
  const composer = () => props.composer
  const controller = () => composer().controller
  const kind = () => controller().state.popover.kind
  const t = () => composer().t
  return (
    <div
      role="listbox"
      id={COMPOSER_LISTBOX_ID}
      data-slot="composer-popover"
      aria-label={t()(kind() === "at" ? "composer.popover.mentions" : "composer.popover.commands")}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Switch>
        <Match when={kind() === "at"}>
          <Show when={composer().suggestions.failed()}>
            {(error) => <div role="alert" data-slot="composer-option-empty">{error().message}</div>}
          </Show>
          <Show when={composer().suggestions.loading() && composer().suggestions.atItems().length === 0}>
            <div data-slot="composer-option-empty"><Loader /></div>
          </Show>
          <Show when={!composer().suggestions.loading() && composer().suggestions.atItems().length === 0}>
            <div data-slot="composer-option-empty">{t()("composer.popover.noResults")}</div>
          </Show>
          <For each={composer().suggestions.atItems()}>
            {(item) => (
              <AtOption
                item={item}
                active={controller().state.activeId === item.id}
                onSelect={() => controller().selectAt(item)}
                onHover={() => controller().setActive(item.id)}
              />
            )}
          </For>
        </Match>
        <Match when={kind() === "slash"}>
          <Show when={composer().suggestions.slashItems().length === 0}>
            <div data-slot="composer-option-empty">{t()("composer.popover.noCommands")}</div>
          </Show>
          <For each={composer().suggestions.slashItems()}>
            {(item) => (
              <SlashOption
                item={item}
                active={controller().state.activeId === item.id}
                onSelect={() => controller().selectSlash(item)}
                onHover={() => controller().setActive(item.id)}
              />
            )}
          </For>
        </Match>
      </Switch>
    </div>
  )
}
