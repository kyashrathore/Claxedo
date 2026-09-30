import type { Deadline } from "../../contract"

export function settledBy(done: Promise<void>, deadline: Deadline): Promise<boolean> {
  if (deadline.signal.aborted) return Promise.resolve(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const late = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false)
    timer = setTimeout(onAbort, Math.max(0, deadline.at - Date.now()))
    deadline.signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([done.then(() => true), late]).finally(() => {
    clearTimeout(timer)
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort)
  })
}
