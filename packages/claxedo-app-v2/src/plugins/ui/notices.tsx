import { For, Show, createSignal, type Component } from "solid-js"
import type { ConfirmInput, ToastInput } from "@claxedo/plugin-api"
import { Button } from "./controls"
import { Dialog } from "./overlays"

const TOAST_MS = 5_000

type Toast = ToastInput & { readonly id: number }

type PendingConfirm = { readonly input: ConfirmInput; readonly resolve: (confirmed: boolean) => void }

export type Notices = {
  readonly toast: (input: ToastInput) => void
  readonly confirm: (input: ConfirmInput) => Promise<boolean>
  readonly Region: Component
}

export function createNotices(): Notices {
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  const [pending, setPending] = createSignal<PendingConfirm | undefined>()
  let nextId = 0

  const dismiss = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id))
  const toast = (input: ToastInput) => {
    const id = nextId++
    setToasts((current) => [...current, { ...input, id }])
    setTimeout(() => dismiss(id), TOAST_MS)
  }
  const confirm = (input: ConfirmInput) =>
    new Promise<boolean>((resolve) => {
      pending()?.resolve(false)
      setPending({ input, resolve })
    })
  const settle = (confirmed: boolean) => {
    pending()?.resolve(confirmed)
    setPending(undefined)
  }

  const Region: Component = () => (
    <>
      <div role="status" aria-live="polite" class="fixed bottom-4 right-4 z-30 flex flex-col gap-2">
        <For each={toasts()}>
          {(entry) => (
            <div data-testid="plugin-toast" data-tone={entry.tone ?? "neutral"} class="rounded-md border px-3 py-2 text-sm">
              <p class="font-medium">{entry.title}</p>
              <Show when={entry.description}>
                <p>{entry.description}</p>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={pending()}>
        {(request) => (
          <Dialog
            open
            onClose={() => settle(false)}
            title={request().input.title}
            description={request().input.description}
            data-testid="plugin-confirm"
            footer={
              <>
                <Button variant="ghost" onClick={() => settle(false)}>
                  Cancel
                </Button>
                <Button variant={request().input.danger ? "danger" : "contrast"} onClick={() => settle(true)}>
                  {request().input.confirmLabel ?? "Confirm"}
                </Button>
              </>
            }
          />
        )}
      </Show>
    </>
  )

  return { toast, confirm, Region }
}
