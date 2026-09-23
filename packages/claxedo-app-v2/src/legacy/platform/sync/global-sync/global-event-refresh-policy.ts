export function shouldFanOutGlobalEventToWorkspaceStores(type: string) {
  // Workspace hosts refresh independently; a global control-plane reconnect is
  // not evidence that every workspace runtime is connected or stale.
  return type === "global.disposed"
}

export function shouldRefreshChildrenForGlobalEvent(type: string) {
  return shouldFanOutGlobalEventToWorkspaceStores(type)
}
