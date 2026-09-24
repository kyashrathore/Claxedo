import type { JSX } from "solid-js"
import type { Confirmation, PluginApi, ToastKind } from "@claxedo/plugin-api"
import { Icon, showToast, type IconName } from "@/ui"
import { ConfirmDialog } from "../view/confirm-dialog"
import type { BindingScope } from "./services"

type Presentation = Pick<PluginApi, "ui" | "i18n">

const TOAST_ICONS: Readonly<Record<ToastKind, IconName | undefined>> = {
  info: undefined,
  success: "circle-check",
  warning: "warning",
  error: "circle-x",
}

function toastIcon(kind: ToastKind): JSX.Element | undefined {
  const name = TOAST_ICONS[kind]
  return name ? <Icon name={name} /> : undefined
}

function confirmWith(scope: BindingScope, confirmation: Confirmation): Promise<boolean> {
  const { dialog } = scope.services
  return new Promise((resolve) => {
    let answered = false
    const answer = (value: boolean) => {
      if (answered) return
      answered = true
      resolve(value)
    }
    const decide = (value: boolean) => {
      answer(value)
      dialog.close()
    }
    void dialog.show(() => <ConfirmDialog confirmation={confirmation} decide={decide} />, () => answer(false))
  })
}

export function presentationBindings(scope: BindingScope): Presentation {
  return {
    ui: {
      toast: (toast) => void showToast({ title: toast.title, description: toast.description, icon: toastIcon(toast.kind) }),
      confirm: (confirmation) => confirmWith(scope, confirmation),
    },
    i18n: { t: (key, params) => scope.services.i18n.t(key, params) },
  }
}
