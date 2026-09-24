import { unreachable } from "@/lib/machine"
import { cloudText } from "../i18n"
import type { CloudWorkspaceState } from "../model"

export function cloudStatusText(state: CloudWorkspaceState): string {
  switch (state.kind) {
    case "provisioning":
      return cloudText("cloud.status.provisioning", { step: state.step })
    case "starting":
      return cloudText("cloud.status.starting")
    case "ready":
      return cloudText("cloud.status.ready")
    case "stopping":
      return cloudText("cloud.status.stopping")
    case "stopped":
      return cloudText("cloud.status.stopped")
    case "failed":
      return cloudText("cloud.status.failed")
    default:
      return unreachable(state)
  }
}
