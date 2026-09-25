export async function eventually<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`${label} was not observed within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
