import type { JSX } from "solid-js"
import { ButtonV2 as Button } from "@opencode-ai/ui/v2/button-v2"
import { DialogV2 as Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import type { useDialog } from "@opencode-ai/ui/context/dialog"

export type ConfirmOptions = {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly cancelLabel: string
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
      <DialogBody class="flex min-w-[340px] max-w-[440px] flex-col gap-4 px-4 pb-4">
        <p class="whitespace-pre-line text-13-regular text-text-weak">{props.options.body}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => props.onCancel()}>
            {props.options.cancelLabel}
          </Button>
          <Button variant="contrast" onClick={() => props.onConfirm()}>
            {props.options.confirmLabel}
          </Button>
        </div>
      </DialogBody>
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
