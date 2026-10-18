import { Show, type JSX } from "solid-js"
import { ButtonV2 as Button } from "@opencode-ai/ui/v2/button-v2"
import { DialogV2 as Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import type { useDialog } from "@opencode-ai/ui/context/dialog"

export type ConfirmOptions = {
  readonly title: string
  readonly body?: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly destructive: boolean
}

function ConfirmBody(props: {
  readonly options: ConfirmOptions
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): JSX.Element {
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.options.title}</DialogTitle>
      </DialogHeader>
      <Show when={props.options.body}>
        {(body) => (
          <DialogBody class="px-4">
            <p class="whitespace-pre-line text-13-regular text-text-weak">{body()}</p>
          </DialogBody>
        )}
      </Show>
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onCancel()}>
          {props.options.cancelLabel}
        </Button>
        <Button variant={props.options.destructive ? "danger" : "contrast"} onClick={() => props.onConfirm()}>
          {props.options.confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

export function requestConfirm(host: ReturnType<typeof useDialog>, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      host.close()
    }
    void host.push(
      () => <ConfirmBody options={options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />,
      () => settle(false),
    )
  })
}
