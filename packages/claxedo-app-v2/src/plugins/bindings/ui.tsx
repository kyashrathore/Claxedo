import type { PluginApi, ToastKind } from "@claxedo/plugin-api"
import { showToast, type ToastVariant } from "@/ui"
import { confirmThrough } from "../view/confirm-dialog"
import type { BindingScope } from "./services"

type Presentation = Pick<PluginApi, "ui" | "i18n">

const TOAST_VARIANTS: Readonly<Record<ToastKind, ToastVariant>> = {
  info: "default",
  success: "success",
  warning: "error",
  error: "error",
}

export function presentationBindings(scope: BindingScope): Presentation {
  return {
    ui: {
      toast: (toast) => void showToast({ title: toast.title, description: toast.description, variant: TOAST_VARIANTS[toast.kind] }),
      confirm: (confirmation) => confirmThrough(scope.services.dialog, confirmation),
    },
    i18n: { t: (key, params) => scope.services.i18n.t(key, params) },
  }
}
