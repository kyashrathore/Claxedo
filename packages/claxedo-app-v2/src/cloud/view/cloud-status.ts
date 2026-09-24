import { unreachable } from "@/lib/machine"
import type { CloudText } from "../i18n"
import type { CloudWorkspaceState } from "../model"

export function cloudStatusText(t: CloudText, state: CloudWorkspaceState): string {
  switch (state.kind) {
    case "provisioning":
      return t("cloud.status.provisioning", { step: state.step })
    case "starting":
      return t("cloud.status.starting")
    case "ready":
      return t("cloud.status.ready")
    case "stopping":
      return t("cloud.status.stopping")
    case "stopped":
      return t("cloud.status.stopped")
    case "failed":
      return t("cloud.status.failed")
    default:
      return unreachable(state)
  }
}
