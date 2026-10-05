import { useCloudText } from "../i18n"

type Named = { readonly id: string; readonly name: string; readonly branch?: string }

export function cloudWorkspaceName(unnamed: string, workspace: Named): string {
  if (workspace.name && workspace.name !== workspace.id) return workspace.name
  return [unnamed, workspace.branch].filter(Boolean).join(" · ")
}

export function useCloudWorkspaceName(): (workspace: Named) => string {
  const t = useCloudText()
  return (workspace) => cloudWorkspaceName(t("cloud.unnamed"), workspace)
}
