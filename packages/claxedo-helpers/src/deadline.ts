export type RequestDeadline = { signal: AbortSignal; deadlineAt: number }

export function settleAtRequestDeadline<T>(
  what: string,
  deadline: RequestDeadline,
  request: Promise<T>,
  abandon: () => void,
  expired: (what: string, aborted: boolean) => Error,
): Promise<T> {
  void request.then(undefined, () => undefined)
  const remaining = deadline.deadlineAt - Date.now()
  if (remaining <= 0 || deadline.signal.aborted) {
    abandon()
    return Promise.reject(expired(what, deadline.signal.aborted))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const stop = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      deadline.signal.removeEventListener("abort", expire)
      return true
    }
    const expire = () => {
      if (!stop()) return
      abandon()
      reject(expired(what, deadline.signal.aborted))
    }
    const timer = setTimeout(expire, remaining)
    deadline.signal.addEventListener("abort", expire, { once: true })
    request.then(
      (value) => { if (stop()) resolve(value) },
      (error: unknown) => { if (stop()) reject(error) },
    )
  })
}
