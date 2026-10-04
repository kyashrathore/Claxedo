import { unreachable } from "@/lib/machine"
import type { CloudWorkspaceStatus } from "@/server"
import { useCloudText, type CloudKey, type CloudText } from "../i18n"

const PROVISIONING_STEP: Readonly<Record<string, CloudKey>> = {
  acquiring_sandbox: "cloud.status.acquiring",
  cloning: "cloud.status.cloning",
  starting_runtime: "cloud.status.startingRuntime",
  waiting_health: "cloud.status.waitingHealth",
}

export function cloudStatusText(t: CloudText, state: CloudWorkspaceStatus): string {
  switch (state.kind) {
    case "provisioning":
      return t(PROVISIONING_STEP[state.step] ?? "cloud.status.provisioning")
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

export function useCloudStatusText(): (state: CloudWorkspaceStatus) => string {
  const t = useCloudText()
  return (state) => cloudStatusText(t, state)
}
