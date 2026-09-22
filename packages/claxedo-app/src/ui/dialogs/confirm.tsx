import type { JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"

/**
 * The slice of the app's `useDialog()` a confirm needs. `push` rather than
 * `show`: a confirm is layered over whatever is already open, never a
 * replacement for it.
 */
export type ConfirmDialogHost = {
  push: (element: () => JSX.Element, onClose?: () => void) => void
  close: () => void
}

export type ConfirmOptions = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
}

/**
 * Open a themed confirm dialog and await the user's decision: `true` on
 * confirm, `false` on cancel or dismiss (Esc, backdrop).
 *
 * A dismiss and a button press can both arrive — the host reports `onClose` for
 * the same interaction that pressed Cancel — so the decision settles once and
 * closes once. This is the app-dialog replacement for native `confirm()`, which
 * does not theme and blocks the event loop.
 */
export function requestConfirm(host: ConfirmDialogHost, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      host.close()
    }
    host.push(
      () => <ConfirmDialog options={options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />,
      () => settle(false),
    )
  })
}

export function ConfirmDialog(props: {
  options: ConfirmOptions
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Dialog title={props.options.title} fit>
      <div class="flex min-w-[340px] max-w-[440px] flex-col gap-4">
        <p class="whitespace-pre-line text-13-regular text-text-weak">{props.options.body}</p>
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
