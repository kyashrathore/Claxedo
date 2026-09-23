export type AppShellNavigationActions = {
  onNewPage?: () => void
}

export function resolveAppShellNavigationActions(input: Readonly<{
  documentNavigationEnabled?: boolean
  onNewPage?: () => void
}>): AppShellNavigationActions {
  return {
    onNewPage: input.documentNavigationEnabled === true ? input.onNewPage : undefined,
  }
}
