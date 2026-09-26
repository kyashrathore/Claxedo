import type { ResizeCoordinator } from "./resize-coordinator"

export type SuspensionTracker = {
  readonly suspended: () => boolean
  readonly check: () => void
}

export function resizeSuspended(): boolean {
  return document.documentElement.dataset.terminalResizeSuspended === "1"
}

export function trackSuspension(coordinator: ResizeCoordinator): SuspensionTracker {
  let wasSuspended = resizeSuspended()
  if (wasSuspended) coordinator.suspend()
  return {
    suspended: () => wasSuspended,
    check: () => {
      const suspended = resizeSuspended()
      if (suspended && !wasSuspended) coordinator.suspend()
      else if (!suspended && wasSuspended) coordinator.resume()
      wasSuspended = suspended
    },
  }
}
