import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, Match, ParentProps, Show, Switch } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  /**
   * Drop the body's horizontal inset so content runs edge to edge.
   *
   * For surfaces that own their own chrome to the card's edge — a command
   * palette, a `<List>` whose rows carry full-width hover states, a settings
   * pane with full-bleed section rules. Content dialogs (copy, form fields,
   * buttons) want the default inset, which lines their left edge up with the
   * title.
   */
  flush?: boolean
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
  onEscapeKeyDown?: ComponentProps<typeof Kobalte.Content>["onEscapeKeyDown"]
  /**
   * Accessible name for the dialog when it renders no `<Kobalte.Title>` (i.e.
   * a header-less dialog). Kobalte's `Dialog.Content` only sets
   * `aria-labelledby` from a mounted `<Kobalte.Title>`, so a title-less dialog
   * would otherwise expose no accessible name (axe `aria-dialog-name`). When a
   * `title` IS provided that title already names the dialog, so this is ignored
   * to avoid two competing name sources.
   */
  "aria-label"?: string
}

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-flush={props.flush ? true : undefined}
      data-size={props.size || "normal"}
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="dialog-container" class="ui-dialog-container">
        <Kobalte.Content
          data-slot="dialog-content"
          aria-label={props.title ? undefined : props["aria-label"]}
          data-no-header={!props.title && !props.action ? "" : undefined}
          classList={{
            ...props.classList,
            [props.class ?? ""]: !!props.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
            }
          }}
          onEscapeKeyDown={props.onEscapeKeyDown}
        >
          <Show when={props.title || props.action}>
            <div data-slot="dialog-header">
              <Show when={props.title}>
                <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
              </Show>
              <Switch>
                <Match when={props.action}>{props.action}</Match>
                <Match when={true}>
                  <Kobalte.CloseButton
                    data-slot="dialog-close-button"
                    as={IconButton}
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                  />
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={props.description}>
            <Kobalte.Description data-slot="dialog-description">{props.description}</Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{props.children}</div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
