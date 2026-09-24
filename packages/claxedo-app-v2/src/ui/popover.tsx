import { Popover as Kobalte } from "@kobalte/core/popover"
import { createEffect, Show, splitProps, type ComponentProps, type JSXElement, type ParentProps, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "./icon-button"
import { listenForDismissal, type DismissReason } from "./popover-dismissal"
import "./popover.css"

export interface PopoverProps<T extends ValidComponent = "div"> extends ParentProps, Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger?: JSXElement
  triggerAs?: T
  triggerProps?: ComponentProps<T>
  title?: JSXElement
  description?: JSXElement
  closeLabel?: string
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
  portal?: boolean
}

export function Popover<T extends ValidComponent = "div">(props: PopoverProps<T>) {
  const [local, rest] = splitProps(props, [
    "trigger",
    "triggerAs",
    "triggerProps",
    "title",
    "description",
    "closeLabel",
    "class",
    "classList",
    "style",
    "children",
    "portal",
    "open",
    "defaultOpen",
    "onOpenChange",
    "modal",
  ])

  const [state, setState] = createStore({
    content: undefined as HTMLElement | undefined,
    trigger: undefined as HTMLElement | undefined,
    dismiss: null as DismissReason | null,
    uncontrolledOpen: local.defaultOpen ?? false,
  })

  const controlled = () => local.open !== undefined
  const opened = () => (controlled() ? (local.open ?? false) : state.uncontrolledOpen)

  const onOpenChange = (next: boolean) => {
    if (next) setState("dismiss", null)
    local.onOpenChange?.(next)
    if (!controlled()) setState("uncontrolledOpen", next)
  }

  createEffect(() => {
    if (!opened()) return
    listenForDismissal({
      owns: (node) => Boolean(state.content?.contains(node) || state.trigger?.contains(node)),
      close: (reason) => {
        setState("dismiss", reason)
        onOpenChange(false)
      },
    })
  })

  const content = () => (
    <Kobalte.Content
      ref={(element: HTMLElement | undefined) => setState("content", element)}
      data-component="popover-content"
      classList={{ "ui-popover": true, ...local.classList, [local.class ?? ""]: !!local.class }}
      style={local.style}
      onCloseAutoFocus={(event: Event) => {
        if (state.dismiss === "outside") event.preventDefault()
        setState("dismiss", null)
      }}
    >
      <Show when={local.title}>
        <div data-slot="popover-header">
          <Kobalte.Title data-slot="popover-title">{local.title}</Kobalte.Title>
          <Kobalte.CloseButton
            data-slot="popover-close-button"
            as={IconButton}
            icon="close"
            size="small"
            variant="ghost"
            aria-label={local.closeLabel ?? "Close"}
          />
        </div>
      </Show>
      <Show when={local.description}>
        <Kobalte.Description data-slot="popover-description">{local.description}</Kobalte.Description>
      </Show>
      <div data-slot="popover-body" class="ui-popover-body">
        {local.children}
      </div>
    </Kobalte.Content>
  )

  return (
    <Kobalte gutter={4} {...rest} open={opened()} onOpenChange={onOpenChange} modal={local.modal ?? false}>
      <Kobalte.Trigger
        ref={(element: HTMLElement) => setState("trigger", element)}
        as={local.triggerAs ?? "div"}
        data-slot="popover-trigger"
        {...local.triggerProps}
      >
        {local.trigger}
      </Kobalte.Trigger>
      <Show when={local.portal ?? true} fallback={content()}>
        <Kobalte.Portal>{content()}</Kobalte.Portal>
      </Show>
    </Kobalte>
  )
}
