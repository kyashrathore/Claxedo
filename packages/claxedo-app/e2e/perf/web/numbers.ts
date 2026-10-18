export function round(value: number) {
  return Math.round(value * 10) / 10
}

export function median(values: readonly number[]) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (finite.length === 0) return undefined
  const middle = Math.floor(finite.length / 2)
  return finite.length % 2 === 1 ? finite[middle] : ((finite[middle - 1] ?? 0) + (finite[middle] ?? 0)) / 2
}
