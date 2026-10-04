export async function pollUntil<T>(read: () => T | undefined | Promise<T | undefined>,
  deadlineAt: number, signal?: AbortSignal): Promise<T | undefined> {
  while (Date.now() < deadlineAt) {
    if (signal?.aborted) return undefined
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}
