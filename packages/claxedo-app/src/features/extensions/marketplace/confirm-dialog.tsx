import type { JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"

/**
 * The slice of the app `useDialog()` API a confirm flow needs. Kept as a
 * structural type so the wiring can be unit-tested with a fake host instead of
 * a live DialogProvider.
 */
export type ConfirmDialogHost = {
  show: (element: () => JSX.Element, onClose?: () => void) => void
  close: () => void
}

export type ConfirmDecisionHandlers = {
  onConfirm: () => void
  onCancel: () => void
}

export type MarketplaceConfirmOptions = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
}

/**
 * Pure confirm-dialog lifecycle. Resolves `true` on confirm and `false` on
 * cancel or dismiss (Esc / backdrop), settling exactly once and closing the
 * dialog exactly once. This is the app-dialog replacement for native
 * `confirm()`, which does not theme and is a poor mobile-web pattern.
 */
export function runConfirmDialog(
  host: ConfirmDialogHost,
  buildElement: (handlers: ConfirmDecisionHandlers) => JSX.Element,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      host.close()
    }
    host.show(
      () => buildElement({ onConfirm: () => settle(true), onCancel: () => settle(false) }),
      () => settle(false),
    )
  })
}

/** Open a themed confirm dialog and await the user's decision. */
export function requestMarketplaceConfirm(host: ConfirmDialogHost, options: MarketplaceConfirmOptions): Promise<boolean> {
  return runConfirmDialog(host, (handlers) => (
    <MarketplaceConfirmDialog options={options} onConfirm={handlers.onConfirm} onCancel={handlers.onCancel} />
  ))
}

export function MarketplaceConfirmDialog(props: {
  options: MarketplaceConfirmOptions
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Dialog title={props.options.title}>
      <div class="flex min-w-[340px] max-w-[440px] flex-col gap-4 p-4">
        <p class="whitespace-pre-line text-[13px] text-text-weak">{props.options.body}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => props.onCancel()}>
            {props.options.cancelLabel ?? "Cancel"}
          </Button>
          <Button variant="primary" onClick={() => props.onConfirm()}>
            {props.options.confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
