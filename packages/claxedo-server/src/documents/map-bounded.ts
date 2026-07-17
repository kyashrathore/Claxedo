export async function mapBounded<T, R>(values: readonly T[], transform: (value: T) => Promise<R>) {
  const result = new Array<R>(values.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (next < values.length) {
        const index = next++
        result[index] = await transform(values[index]!)
      }
    }),
  )
  return result
}
