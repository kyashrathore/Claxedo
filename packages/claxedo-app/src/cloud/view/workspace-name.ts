import { useCloudText, type CloudText } from "../i18n"

export type WorkspaceName = (name: string | undefined, branch: string | undefined) => string

export function workspaceName(t: CloudText): WorkspaceName {
  return (name, branch) => name ?? [t("cloud.unnamed"), branch].filter(Boolean).join(" · ")
}

export function useWorkspaceName(): WorkspaceName {
  return workspaceName(useCloudText())
}
