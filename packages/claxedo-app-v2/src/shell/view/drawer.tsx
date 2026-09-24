import { Dialog } from "@kobalte/core/dialog"
import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Icon } from "@/ui"
import { dictionary } from "../i18n"

export function PhoneDrawer(props: {
  readonly open: boolean
  readonly onClose: () => void
  readonly side: "left" | "bottom"
  readonly label: string
  readonly testId: string
  readonly children: JSX.Element
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="shell-scrim" />
        <Dialog.Content class="shell-drawer" data-side={props.side} aria-label={props.label} data-testid={props.testId}>
          <div class="shell-drawer-header">
            <Dialog.Title class="shell-drawer-title">{props.label}</Dialog.Title>
            <Dialog.CloseButton class="shell-drawer-close" aria-label={t("shell.close")}>
              <Icon name="close" size="medium" />
            </Dialog.CloseButton>
          </div>
          <div class="shell-drawer-body">{props.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
