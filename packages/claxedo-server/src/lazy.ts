export function lazy<T>(fn: () => T): (() => T) & { reset(): void } {
  let v: T | undefined
  let loaded = false
  return Object.assign(
    () => {
      if (!loaded) { v = fn(); loaded = true }
      return v!
    },
    { reset() { loaded = false; v = undefined } },
  )
}
