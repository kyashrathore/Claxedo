import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { Show, children } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "./button"
import "./toast.css"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return (
    <Portal>
      <Kobalte.Region data-component="v2-toast-region" {...props}>
        <Kobalte.List data-slot="v2-toast-list" />
      </Kobalte.Region>
    </Portal>
  )
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="v2-toast"
      classList={{
        "v2-toast": true,
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: ComponentProps<"div">) {
  return <div data-slot="v2-toast-icon" {...props} />
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="v2-toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="v2-toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="v2-toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="v2-toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  return (
    <Kobalte.CloseButton data-slot="v2-toast-close-button" aria-label="Dismiss" {...props}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4.25 11.75L11.75 4.25" stroke="currentColor" />
        <path d="M11.75 11.75L4.25 4.25" stroke="currentColor" />
      </svg>
    </Kobalte.CloseButton>
  )
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
})

export { toaster }

export interface ToastAction {
  label: string
  variant?: "primary" | "secondary"
  onClick: "dismiss" | (() => void)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: JSX.Element
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
}

export function showToast(options: ToastOptions | string) {
  const opts = typeof options === "string" ? { description: options } : options
  return toaster.show((props) => {
    const resolvedIcon = children(() => opts.icon)
    return (
      <Toast toastId={props.toastId} duration={opts.duration} persistent={opts.persistent}>
        <div data-slot="v2-toast-header">
          <Show when={resolvedIcon()}>
            <Toast.Icon>{resolvedIcon()}</Toast.Icon>
          </Show>
          <Toast.Content>
            <Show when={opts.title}>
              <Toast.Title>{opts.title}</Toast.Title>
            </Show>
            <Show when={opts.description}>
              <Toast.Description>{opts.description}</Toast.Description>
            </Show>
          </Toast.Content>
          <Toast.CloseButton />
        </div>
        <Show when={opts.actions?.length}>
          <Toast.Actions>
            {opts.actions!.map((action) => (
              <Button
                variant={action.variant === "secondary" ? "ghost" : "neutral"}
                size="small"
                data-action-variant={action.variant ?? "primary"}
                onClick={() => {
                  if (typeof action.onClick === "function") {
                    action.onClick()
                  }
                  toaster.dismiss(props.toastId)
                }}
              >
                {action.label}
              </Button>
            ))}
          </Toast.Actions>
        </Show>
      </Toast>
    )
  })
}
