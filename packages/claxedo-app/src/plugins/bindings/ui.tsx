import type { Confirmation, PluginApi, ToastKind } from "@claxedo/plugin-api"
import { requestConfirm, showToast, type ToastVariant } from "@/ui"
import { pluginsDictionary } from "../i18n"
import type { BindingScope } from "./services"

type Presentation = Pick<PluginApi, "ui" | "i18n">

const TOAST_VARIANTS: Readonly<Record<ToastKind, ToastVariant>> = {
  info: "default",
  success: "success",
  warning: "error",
  error: "error",
}

function confirmThrough(scope: BindingScope, confirmation: Confirmation): Promise<boolean> {
  const { i18n, dialog } = scope.services
  i18n.add(pluginsDictionary)
  return requestConfirm(dialog, {
    title: confirmation.title,
    ...(confirmation.description === undefined ? {} : { body: confirmation.description }),
    confirmLabel: confirmation.confirmLabel ?? i18n.t("plugins.confirm"),
    cancelLabel: confirmation.cancelLabel ?? i18n.t("plugins.cancel"),
    destructive: false,
  })
}

export function presentationBindings(scope: BindingScope): Presentation {
  return {
    ui: {
      toast: (toast) => void showToast({ title: toast.title, description: toast.description, variant: TOAST_VARIANTS[toast.kind] }),
      confirm: (confirmation) => confirmThrough(scope, confirmation),
    },
    i18n: { t: (key, params) => scope.services.i18n.t(key, params) },
  }
}
