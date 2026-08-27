export type AppShellNavigationActions = {
  onNewPage?: () => void
  onNewTask?: () => void
  onOpenWorkGraph?: () => void
}

export function resolveAppShellNavigationActions(input: Readonly<{
  documentNavigationEnabled?: boolean
  workGraphNavigationEnabled?: boolean
  onNewPage?: () => void
  onNewTask?: () => void
  onOpenWorkGraph?: () => void
}>): AppShellNavigationActions {
  return {
    onNewPage: input.documentNavigationEnabled === true ? input.onNewPage : undefined,
    onNewTask: input.workGraphNavigationEnabled === true ? input.onNewTask : undefined,
    onOpenWorkGraph: input.workGraphNavigationEnabled === true ? input.onOpenWorkGraph : undefined,
  }
}
