import type { JSX } from "solid-js"
import type { PluginApi, ToastKind } from "@claxedo/plugin-api"
import { Icon, showToast, type IconName } from "@/ui"
import { confirmThrough } from "../view/confirm-dialog"
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

export function presentationBindings(scope: BindingScope): Presentation {
  return {
    ui: {
      toast: (toast) => void showToast({ title: toast.title, description: toast.description, icon: toastIcon(toast.kind) }),
      confirm: (confirmation) => confirmThrough(scope.services.dialog, confirmation),
    },
    i18n: { t: (key, params) => scope.services.i18n.t(key, params) },
  }
}
