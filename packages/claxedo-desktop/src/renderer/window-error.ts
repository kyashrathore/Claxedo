const resizeObserverDeliveryErrors = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
])

export function isResizeObserverDeliveryError(message: string) {
  return resizeObserverDeliveryErrors.has(message)
}
